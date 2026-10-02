import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writeManifest } from "../src/config.ts";
import { formatWorktreeList, listWorktrees } from "../src/list.ts";
import type { WorkforestManifest } from "../src/manifest.ts";

const tempDirs: string[] = [];
const cliPath = resolve(import.meta.dir, "../src/cli.ts");

function createFixture(): { cwd: string; manifest: WorkforestManifest } {
  const cwd = mkdtempSync(join(tmpdir(), "workforest-list-"));
  tempDirs.push(cwd);
  const mainPath = join(cwd, "main");
  const detachedPath = join(cwd, "detached");
  mkdirSync(mainPath);
  mkdirSync(detachedPath);
  const manifest: WorkforestManifest = {
    version: 1,
    repo: { name: "list-fixture", root: mainPath },
    worktrees: [
      {
        path: join(cwd, "stale"),
        branch: "feature/stale",
        isMain: false,
        ignoreShared: [".env"],
      },
      { path: mainPath, branch: "main", isMain: true },
      { path: detachedPath, branch: null, isMain: false },
    ],
    shared: { ".env": ".env" },
  };
  writeManifest(join(cwd, "workforest.yaml"), manifest);
  return { cwd, manifest };
}

function runCli(cwd: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliPath, "list", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("listWorktrees", () => {
  test("preserves manifest order and reports main, detached, and missing paths", () => {
    const { cwd, manifest } = createFixture();
    const content = readFileSync(join(cwd, "workforest.yaml"), "utf8");

    expect(listWorktrees(cwd)).toEqual([
      {
        path: manifest.worktrees[0].path,
        branch: "feature/stale",
        isMain: false,
        exists: false,
      },
      {
        path: manifest.worktrees[1].path,
        branch: "main",
        isMain: true,
        exists: true,
      },
      {
        path: manifest.worktrees[2].path,
        branch: null,
        isMain: false,
        exists: true,
      },
    ]);
    expect(readFileSync(join(cwd, "workforest.yaml"), "utf8")).toBe(content);
  });

  test("discovers a parent manifest from inside a Git worktree", () => {
    const { cwd, manifest } = createFixture();
    const mainPath = manifest.repo.root;
    runGit(mainPath, ["init", "-b", "main"]);
    const nestedPath = join(mainPath, "src");
    mkdirSync(nestedPath);

    expect(listWorktrees(nestedPath)).toEqual(listWorktrees(cwd));
  });

  test("formats stable aligned human output with detached and disk state", () => {
    expect(
      formatWorktreeList([
        { path: "/repo/main", branch: "main", isMain: true, exists: true },
        { path: "/repo/stale", branch: null, isMain: false, exists: false },
      ]),
    ).toBe(
      "PATH         BRANCH    STATE    ROLE\n" +
        "/repo/main   main      present  main\n" +
        "/repo/stale  detached  missing  worktree",
    );
    expect(formatWorktreeList([])).toBe("PATH  BRANCH  STATE  ROLE");
  });
});

describe("wf list", () => {
  test("emits the exact JSON schema without changing the manifest", () => {
    const { cwd } = createFixture();
    const content = readFileSync(join(cwd, "workforest.yaml"), "utf8");
    const result = runCli(cwd, "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual(listWorktrees(cwd));
    expect(readFileSync(join(cwd, "workforest.yaml"), "utf8")).toBe(content);
  });

  test("prints one row per manifest worktree by default", () => {
    const { cwd } = createFixture();
    const result = runCli(cwd);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(
      `${formatWorktreeList(listWorktrees(cwd))}\n`,
    );
  });

  test("reports a missing manifest with one primary error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "workforest-list-missing-"));
    tempDirs.push(cwd);
    const result = runCli(cwd, "--json");

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      `Missing workforest manifest: ${join(cwd, "workforest.yaml")}\n`,
    );
  });

  test("rejects an invalid manifest", () => {
    const { cwd } = createFixture();
    writeFileSync(join(cwd, "workforest.yaml"), "version: 999\n");
    const result = runCli(cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Unsupported or missing workforest manifest version.\n",
    );
  });

  test("rejects unknown flags", () => {
    const { cwd } = createFixture();
    const result = runCli(cwd, "--sort");

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("unknown option '--sort'");
  });
});
