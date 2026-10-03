import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readManifest, writeManifest } from "../src/lib/config.ts";
import { discoverRepo } from "../src/lib/git.ts";
import type { SharedPath } from "../src/lib/manifest.ts";

const tempDirs: string[] = [];
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function setupRepo(shared: Record<string, SharedPath>) {
  const root = mkdtempSync(join(tmpdir(), "workforest-glob-"));
  tempDirs.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Workforest Test");
  git(main, "config", "user.email", "workforest@example.com");
  writeFileSync(join(main, "README.md"), "initial\n");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "Initial commit");
  mkdirSync(join(main, "assets", "nested", "deep"), { recursive: true });
  for (const file of [
    "a.txt",
    "b.txt",
    ".hidden.txt",
    "config.json",
    "nested/c.txt",
    "nested/deep/d.txt",
    "nested/other.json",
  ])
    writeFileSync(join(main, "assets", file), `original ${file}\n`);
  const discovered = discoverRepo(main);
  writeManifest(join(root, "workforest.yaml"), {
    version: 1,
    repo: { name: discovered.repoName, root: main },
    worktrees: discovered.activeWorktrees,
    shared,
  });
  return { root, main, feature: join(root, "feature") };
}
function runCli(cwd: string, ...args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
}
afterEach(() => {
  for (const root of tempDirs.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("CLI shared glob matching", () => {
  test("single star selects only matching files in one segment across create, sync, and status", () => {
    const { root, main, feature } = setupRepo({ "assets/*.txt": "selected/" });
    expect(runCli(root, "create", "feature", "feature").exitCode).toBe(0);
    for (const file of ["a.txt", "b.txt", ".hidden.txt"])
      expect(lstatSync(join(feature, "selected", file)).isSymbolicLink()).toBe(
        true,
      );
    expect(existsSync(join(feature, "selected", "config.json"))).toBe(false);
    expect(existsSync(join(feature, "selected", "nested"))).toBe(false);
    writeFileSync(join(main, "assets", "new.txt"), "new selected file\n");
    writeFileSync(join(main, "assets", "new.json"), "unselected\n");
    const status = runCli(root, "status", "feature", "--json");
    expect(status.exitCode).toBe(1);
    expect(JSON.parse(status.stdout.toString()).findings).toMatchObject([
      {
        code: "shared_link_missing",
        path: join(feature, "selected", "new.txt"),
      },
    ]);
    expect(JSON.parse(status.stdout.toString()).findings).toHaveLength(1);
    expect(runCli(root, "sync").exitCode).toBe(0);
    expect(readFileSync(join(feature, "selected", "new.txt"), "utf8")).toBe(
      "new selected file\n",
    );
    expect(existsSync(join(feature, "selected", "new.json"))).toBe(false);
    expect(runCli(root, "status", "--json").exitCode).toBe(0);
  });

  test("recursive text copies preserve hierarchy, exclusions, and selective refresh by source or target", () => {
    const sourceKey = "assets/**/*.txt";
    const { root, main, feature } = setupRepo({
      [sourceKey]: { target: "selected/", copy: true },
      "absent/**/*.txt": "absent/",
    });
    expect(runCli(root, "create", "feature", "feature").exitCode).toBe(0);
    for (const file of [
      "a.txt",
      ".hidden.txt",
      "nested/c.txt",
      "nested/deep/d.txt",
    ])
      expect(readFileSync(join(feature, "selected", file), "utf8")).toBe(
        `original ${file}\n`,
      );
    expect(existsSync(join(feature, "selected", "config.json"))).toBe(false);
    expect(existsSync(join(feature, "selected", "nested", "other.json"))).toBe(
      false,
    );
    expect(existsSync(join(feature, "absent"))).toBe(false);
    writeFileSync(join(feature, "selected", "b.txt"), "independent b\n");
    writeFileSync(join(main, "assets", "nested", "c.txt"), "updated c\n");
    writeFileSync(
      join(main, "assets", "nested", "deep", "d.txt"),
      "updated d\n",
    );
    expect(runCli(root, "sync").exitCode).toBe(0);
    expect(
      readFileSync(join(feature, "selected", "nested", "c.txt"), "utf8"),
    ).toBe("original nested/c.txt\n");
    expect(
      runCli(root, "sync", "--refresh", "assets/nested/c.txt").exitCode,
    ).toBe(0);
    expect(
      readFileSync(join(feature, "selected", "nested", "c.txt"), "utf8"),
    ).toBe("updated c\n");
    expect(
      readFileSync(
        join(feature, "selected", "nested", "deep", "d.txt"),
        "utf8",
      ),
    ).toBe("original nested/deep/d.txt\n");
    expect(
      runCli(root, "sync", "--refresh", "selected/nested/deep/d.txt").exitCode,
    ).toBe(0);
    expect(
      readFileSync(
        join(feature, "selected", "nested", "deep", "d.txt"),
        "utf8",
      ),
    ).toBe("updated d\n");
    expect(readFileSync(join(feature, "selected", "b.txt"), "utf8")).toBe(
      "independent b\n",
    );
    const { manifestPath, manifest } = readManifest(root);
    manifest.worktrees.find((entry) => entry.path === feature)!.ignoreShared = [
      sourceKey,
    ];
    writeManifest(manifestPath, manifest);
    writeFileSync(
      join(main, "assets", "nested", "c.txt"),
      "excluded source change\n",
    );
    expect(
      runCli(root, "sync", "--refresh", "assets/nested/c.txt").exitCode,
    ).toBe(0);
    expect(
      readFileSync(join(feature, "selected", "nested", "c.txt"), "utf8"),
    ).toBe("updated c\n");
    expect(runCli(root, "status", "--json").exitCode).toBe(0);
  });

  for (const pattern of [
    "assets/*.{txt,json}",
    "assets/?.txt",
    "assets/[ab]*.txt",
    "assets/***.txt",
    "assets/*(a).txt",
    "assets/\\*.txt",
  ]) {
    test(`unsupported glob ${pattern} is rejected before creating a branch or worktree`, () => {
      const { root, main, feature } = setupRepo({
        [pattern]: "selected/",
      });
      const before = readFileSync(join(root, "workforest.yaml"), "utf8");
      const result = runCli(root, "create", "feature", "feature");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "Unsupported shared glob pattern",
      );
      expect(existsSync(feature)).toBe(false);
      expect(git(main, "branch", "--list", "feature").trim()).toBe("");
      expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(before);
    });
  }

  test("literal wildcard prefixes and single-star directory segments retain their selected hierarchy", () => {
    const { root, feature } = setupRepo({
      "assets/a*.txt": "prefix/",
      "assets/*/*.txt": "one-level/",
    });
    expect(runCli(root, "create", "feature", "feature").exitCode).toBe(0);
    expect(readFileSync(join(feature, "prefix", "a.txt"), "utf8")).toBe(
      "original a.txt\n",
    );
    expect(existsSync(join(feature, "prefix", "b.txt"))).toBe(false);
    expect(
      readFileSync(join(feature, "one-level", "nested", "c.txt"), "utf8"),
    ).toBe("original nested/c.txt\n");
    expect(existsSync(join(feature, "one-level", "a.txt"))).toBe(false);
    expect(existsSync(join(feature, "one-level", "nested", "deep"))).toBe(
      false,
    );
    expect(runCli(root, "status", "--json").exitCode).toBe(0);
  });
});
