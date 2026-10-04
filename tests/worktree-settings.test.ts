import { afterEach, describe, expect, test } from "bun:test";
import {
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

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "workforest-policy-"));
  tempDirs.push(root);
  const main = join(root, "main");
  const feature = join(root, "feature");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Workforest Test");
  git(main, "config", "user.email", "workforest@example.com");
  writeFileSync(join(main, "README.md"), "initial\n");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "Initial commit");
  git(main, "worktree", "add", "-b", "feature", feature);
  writeFileSync(join(main, ".env"), "shared source\n");
  writeFileSync(join(feature, ".env"), "independent secret\n");
  const discovered = discoverRepo(main);
  writeManifest(join(root, "workforest.yaml"), {
    version: 1,
    repo: { name: discovered.repoName, root: main },
    worktrees: discovered.activeWorktrees.map((entry) =>
      entry.path === feature
        ? {
            ...entry,
            path: `${feature}/../feature/./`,
            description: "Investigate login: feature notes",
            ignoreShared: [".env"],
          }
        : { ...entry, description: "Main checkout notes" },
    ),
    shared: { ".env": ".env" },
  });
  return { root, main, feature };
}

function runCli(cwd: string, ...args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function expectPreservedPolicy(root: string, feature: string) {
  const { manifest } = readManifest(root);
  expect(manifest.worktrees.find((entry) => entry.isMain)?.description).toBe(
    "Main checkout notes",
  );
  expect(
    manifest.worktrees.find((entry) => entry.path === feature)?.description,
  ).toBe("Investigate login: feature notes");
  expect(lstatSync(join(feature, ".env")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(feature, ".env"), "utf8")).toBe(
    "independent secret\n",
  );
  expect(
    readManifest(root).manifest.worktrees.find(
      (entry) => entry.path === feature,
    )?.ignoreShared,
  ).toEqual([".env"]);
}

afterEach(() => {
  for (const root of tempDirs.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("CLI worktree policy reconciliation", () => {
  test("sync preserves exclusions and local contents for equivalent absolute paths", () => {
    const { root, main, feature } = setupRepo();
    const result = runCli(root, "sync");
    expect(result.exitCode).toBe(0);
    expectPreservedPolicy(root, feature);
    expect(readFileSync(join(main, ".env"), "utf8")).toBe("shared source\n");
    expect(result.stdout.toString()).toContain("(0 created, 0 removed,");
  });

  test("create preserves surviving exclusions across equivalent absolute paths", () => {
    const { root, feature } = setupRepo();
    const result = runCli(root, "create", "other", "other");
    expect(result.exitCode).toBe(0);
    expectPreservedPolicy(root, feature);
    expect(lstatSync(join(root, "other", ".env")).isSymbolicLink()).toBe(true);
    expect(readManifest(root).manifest.worktrees).toHaveLength(3);
  });

  test("remove preserves surviving exclusions across equivalent absolute paths", () => {
    const { root, main, feature } = setupRepo();
    const other = join(root, "other");
    git(main, "worktree", "add", "-b", "other", other);
    const { manifestPath, manifest } = readManifest(root);
    manifest.worktrees.push({ path: other, branch: "other", isMain: false });
    writeManifest(manifestPath, manifest);
    const result = runCli(root, "remove", "other");
    expect(result.exitCode).toBe(0);
    expectPreservedPolicy(root, feature);
    expect(readManifest(root).manifest.worktrees).toHaveLength(2);
    const sync = runCli(root, "sync");
    expect(sync.exitCode).toBe(0);
    expectPreservedPolicy(root, feature);
  });
});
