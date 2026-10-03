import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  const root = mkdtempSync(join(tmpdir(), "workforest-persistence-"));
  tempDirs.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Workforest Test");
  git(main, "config", "user.email", "workforest@example.com");
  writeFileSync(join(main, "README.md"), "initial\n");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "Initial commit");
  const discovered = discoverRepo(main);
  writeManifest(join(root, "workforest.yaml"), {
    version: 1,
    repo: { name: discovered.repoName, root: main },
    worktrees: discovered.activeWorktrees.map((entry) => ({
      ...entry,
      ignoreShared: [".env"],
    })),
    shared: {
      ".env": ".env",
      "README.md": { target: "readme-copy", copy: true },
    },
  });
  return { root, main };
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
afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CLI manifest persistence", () => {
  test("failed sync persistence leaves the previous complete manifest unchanged and readable", () => {
    const { root, main } = setupRepo();
    const before = readFileSync(join(root, "workforest.yaml"), "utf8");
    const policy = readManifest(root).manifest;
    git(main, "worktree", "add", "-b", "adopted", join(root, "adopted"));
    const entries = readdirSync(root).sort();
    chmodSync(root, 0o555);
    const result = runCli(root, "sync");
    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(before);
    expect(readManifest(root).manifest).toEqual(policy);
    expect(readdirSync(root).sort()).toEqual(entries);
    expect(runCli(root, "list", "--json").exitCode).toBe(0);
  });

  test("successful rewrites preserve sharing policy, exclusions, and restricted permissions", () => {
    const { root, main } = setupRepo();
    const original = readManifest(root).manifest;
    chmodSync(join(root, "workforest.yaml"), 0o600);
    git(main, "worktree", "add", "-b", "adopted", join(root, "adopted"));
    const entries = readdirSync(root).sort();
    const result = runCli(root, "sync");
    expect(result.exitCode).toBe(0);
    const rewritten = readManifest(root).manifest;
    expect(rewritten.shared).toEqual(original.shared);
    expect(
      rewritten.worktrees.find((entry) => entry.isMain)?.ignoreShared,
    ).toEqual([".env"]);
    expect(rewritten.worktrees).toHaveLength(2);
    expect(statSync(join(root, "workforest.yaml")).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).sort()).toEqual(entries);
    expect(runCli(root, "list", "--json").exitCode).toBe(0);
  });

  test("init refuses to overwrite existing manifest bytes", () => {
    const { root } = setupRepo();
    const before = readFileSync(join(root, "workforest.yaml"), "utf8");
    const result = runCli(root, "init", "main");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Refusing to overwrite existing manifest",
    );
    expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(before);
  });

  test("failed initialization publishes no incomplete manifest", () => {
    const { root } = setupRepo();
    rmSync(join(root, "workforest.yaml"));
    const entries = readdirSync(root).sort();
    chmodSync(root, 0o555);
    const result = runCli(root, "init", "main");
    expect(result.exitCode).toBe(1);
    expect(readdirSync(root).sort()).toEqual(entries);
    chmodSync(root, 0o700);
    expect(runCli(root, "init", "main").exitCode).toBe(0);
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  });
});
