import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeWorktree } from "../src/commands/remove/remove.ts";
import { readManifest, writeManifest } from "../src/lib/config.ts";
import { discoverRepo } from "../src/lib/git.ts";

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "workforest-remove-"));
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
  git(main, "worktree", "add", "-b", "feature/demo", feature);
  const discovered = discoverRepo(main);
  writeManifest(join(root, "workforest.yaml"), {
    version: 1,
    repo: { name: discovered.repoName, root: main },
    worktrees: discovered.activeWorktrees,
    shared: {},
  });
  return { root, main, feature };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("removeWorktree", () => {
  test("removes a clean worktree by branch while retaining the branch by default", async () => {
    const { root, main, feature } = setupRepo();
    const result = await removeWorktree(root, "feature/demo");

    expect(result).toMatchObject({
      worktreePath: feature,
      branchName: "feature/demo",
      forceUsed: false,
      alreadyMissing: false,
      branchDeletionRequested: false,
      branchDeleted: false,
    });
    expect(existsSync(feature)).toBe(false);
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
  });

  test("resolves normalized absolute and cwd-relative paths", async () => {
    const { root, main, feature } = setupRepo();
    mkdirSync(join(main, "nested"));
    const result = await removeWorktree(
      join(main, "nested"),
      "../../feature/../feature",
    );
    expect(result.worktreePath).toBe(feature);
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  });

  test("refuses the main worktree even with force and branch deletion", async () => {
    const { root, main } = setupRepo();
    await expect(
      removeWorktree(root, main, { force: true, deleteBranch: true }),
    ).rejects.toThrow(/main worktree/);
    expect(existsSync(main)).toBe(true);
    expect(readManifest(root).manifest.worktrees).toHaveLength(2);
  });

  test("protects repo.root even when the manifest main marker is incorrect", async () => {
    const { root, main } = setupRepo();
    const { manifestPath, manifest } = readManifest(root);
    manifest.worktrees[0].isMain = false;
    writeManifest(manifestPath, manifest);
    await expect(removeWorktree(root, main)).rejects.toThrow(/main worktree/);
  });

  test("refuses both tracked modifications and untracked files without force", async () => {
    const { root, feature } = setupRepo();
    writeFileSync(join(feature, "README.md"), "modified\n");
    await expect(removeWorktree(root, "feature/demo")).rejects.toThrow(
      /--force/,
    );
    git(feature, "restore", "README.md");
    writeFileSync(join(feature, "untracked.txt"), "untracked\n");
    await expect(removeWorktree(root, "feature/demo")).rejects.toThrow(
      /--force/,
    );
    expect(existsSync(feature)).toBe(true);
    expect(readManifest(root).manifest.worktrees).toHaveLength(2);
  });

  test("removes dirty worktrees with force", async () => {
    const { root, feature } = setupRepo();
    writeFileSync(join(feature, "README.md"), "modified\n");
    writeFileSync(join(feature, "untracked.txt"), "untracked\n");
    expect(
      (await removeWorktree(root, feature, { force: true })).forceUsed,
    ).toBe(true);
    expect(existsSync(feature)).toBe(false);
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  });

  test("safely deletes a merged branch when requested", async () => {
    const { root, main } = setupRepo();
    const result = await removeWorktree(root, "feature/demo", {
      deleteBranch: true,
    });
    expect(result.branchDeleted).toBe(true);
    expect(result.branchDeletionRequested).toBe(true);
    expect(git(main, "branch", "--list", "feature/demo")).toBe("");
  });

  test("retains an unmerged branch and repairs the manifest after removal", async () => {
    const { root, main, feature } = setupRepo();
    writeFileSync(join(feature, "feature.txt"), "feature change\n");
    git(feature, "add", "feature.txt");
    git(feature, "commit", "-m", "Feature change");
    await expect(
      removeWorktree(root, "feature/demo", { deleteBranch: true, force: true }),
    ).rejects.toThrow(/branch deletion failed/);
    expect(existsSync(feature)).toBe(false);
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
  });

  test("repairs a manually deleted directory and retains its branch", async () => {
    const { root, main, feature } = setupRepo();
    rmSync(feature, { recursive: true });
    const result = await removeWorktree(root, "feature/demo", { force: true });
    expect(result.alreadyMissing).toBe(true);
    expect(result.forceUsed).toBe(false);
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
    expect(discoverRepo(main).activeWorktrees).toHaveLength(1);
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
  });

  test("prunes missing worktrees before requested branch deletion", async () => {
    const { root, main, feature } = setupRepo();
    rmSync(feature, { recursive: true });
    expect(
      (await removeWorktree(root, "feature/demo", { deleteBranch: true }))
        .branchDeleted,
    ).toBe(true);
    expect(git(main, "branch", "--list", "feature/demo")).toBe("");
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  });

  test("preserves remaining exclusions and refreshes newly discovered worktrees", async () => {
    const { root, main } = setupRepo();
    const other = join(root, "other");
    git(main, "worktree", "add", "-b", "other", other);
    const { manifestPath, manifest } = readManifest(root);
    manifest.worktrees[0].ignoreShared = ["node_modules", ".env"];
    manifest.shared = { ".env": ".env" };
    writeManifest(manifestPath, manifest);
    await removeWorktree(root, "feature/demo");
    const updated = readManifest(root).manifest;
    expect(updated.worktrees).toHaveLength(2);
    expect(
      updated.worktrees.find((entry) => entry.isMain)?.ignoreShared,
    ).toEqual(["node_modules", ".env"]);
    expect(updated.worktrees.some((entry) => entry.path === other)).toBe(true);
    expect(updated.shared).toEqual({ ".env": ".env" });
  });

  test("does not delete the branch or rewrite the manifest when removal fails", async () => {
    const { root, main, feature } = setupRepo();
    const before = readFileSync(join(root, "workforest.yaml"), "utf8");
    git(main, "worktree", "lock", feature);
    await expect(
      removeWorktree(root, "feature/demo", { deleteBranch: true }),
    ).rejects.toThrow(/locked/);
    expect(existsSync(feature)).toBe(true);
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
    expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(before);
  });

  test("rejects unknown and ambiguous targets before changing the repository", async () => {
    const { root, main, feature } = setupRepo();
    await expect(removeWorktree(root, "not-present")).rejects.toThrow(
      /no worktree matches/i,
    );
    const { manifestPath, manifest } = readManifest(root);
    const duplicate = join(root, "duplicate");
    manifest.worktrees.push({
      path: duplicate,
      branch: "feature/demo",
      isMain: false,
    });
    writeManifest(manifestPath, manifest);
    let errorMessage = "";
    try {
      await removeWorktree(root, "feature/demo");
    } catch (error) {
      errorMessage = (error as Error).message;
    }
    expect(errorMessage).toMatch(/ambiguous/i);
    expect(errorMessage).toContain(feature);
    expect(errorMessage).toContain(duplicate);
    expect(existsSync(feature)).toBe(true);
    expect(discoverRepo(main).activeWorktrees).toHaveLength(2);
  });

  test("requires a manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "workforest-remove-missing-"));
    tempDirs.push(root);
    await expect(removeWorktree(root, "feature/demo")).rejects.toThrow(
      /manifest/i,
    );
  });

  test("removes detached worktrees without attempting branch deletion", async () => {
    const { root, main, feature } = setupRepo();
    git(feature, "checkout", "--detach");
    const { manifestPath, manifest } = readManifest(root);
    manifest.worktrees = discoverRepo(main).activeWorktrees;
    writeManifest(manifestPath, manifest);
    const result = await removeWorktree(root, feature, { deleteBranch: true });
    expect(result.branchName).toBeNull();
    expect(result.branchDeletionRequested).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(existsSync(feature)).toBe(false);
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
  });
});

describe("wf remove CLI", () => {
  function runRemove(cwd: string, ...args: string[]) {
    return Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "remove",
        ...args,
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
  }

  test("rejects an obsolete branch and deletes only the live branch when removing by path", () => {
    const { root, main, feature } = setupRepo();
    git(feature, "checkout", "-b", "feature/current");
    const beforeManifest = readFileSync(join(root, "workforest.yaml"), "utf8");
    const beforeGit = git(main, "worktree", "list", "--porcelain");
    const obsolete = runRemove(root, "feature/demo", "--delete-branch");
    expect(obsolete.exitCode).toBe(1);
    expect(obsolete.stderr.toString()).toMatch(/obsolete.*association/i);
    expect(existsSync(feature)).toBe(true);
    expect(git(main, "worktree", "list", "--porcelain")).toBe(beforeGit);
    expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(
      beforeManifest,
    );
    const current = runRemove(root, feature, "--delete-branch");
    expect(current.exitCode).toBe(0);
    expect(current.stdout.toString()).toContain("[feature/current]");
    expect(existsSync(feature)).toBe(false);
    expect(git(main, "branch", "--list", "feature/current")).toBe("");
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  });

  test("removes a detached worktree by path without deleting its cached branch", () => {
    const { root, main, feature } = setupRepo();
    git(feature, "checkout", "--detach");
    const result = runRemove(root, feature, "--delete-branch");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("[detached]");
    expect(existsSync(feature)).toBe(false);
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  });

  test("never redirects an obsolete branch onto a different registered worktree", () => {
    const { root, main, feature } = setupRepo();
    git(feature, "checkout", "-b", "feature/current");
    const other = join(root, "other");
    git(main, "worktree", "add", other, "feature/demo");
    const beforeManifest = readFileSync(join(root, "workforest.yaml"), "utf8");
    const beforeGit = git(main, "worktree", "list", "--porcelain");
    const result = runRemove(
      root,
      "feature/demo",
      "--force",
      "--delete-branch",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toMatch(/obsolete.*association/i);
    expect(existsSync(feature)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(git(main, "worktree", "list", "--porcelain")).toBe(beforeGit);
    expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(
      beforeManifest,
    );
  });

  test("inspects a missing worktree's current branch before pruning", () => {
    const { root, main, feature } = setupRepo();
    git(feature, "checkout", "-b", "feature/current");
    rmSync(feature, { recursive: true });
    const beforeGit = git(main, "worktree", "list", "--porcelain");
    const obsolete = runRemove(root, "feature/demo", "--delete-branch");
    expect(obsolete.exitCode).toBe(1);
    expect(git(main, "worktree", "list", "--porcelain")).toBe(beforeGit);
    const result = runRemove(root, feature, "--delete-branch");
    expect(result.exitCode).toBe(0);
    expect(git(main, "branch", "--list", "feature/current")).toBe("");
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
    expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  });

  test("accepts a live branch target that is absent from the cached inventory", () => {
    const { root, main, feature } = setupRepo();
    git(feature, "checkout", "-b", "feature/current");
    const result = runRemove(root, "feature/current", "--delete-branch");
    expect(result.exitCode).toBe(0);
    expect(existsSync(feature)).toBe(false);
    expect(git(main, "branch", "--list", "feature/current")).toBe("");
    expect(git(main, "branch", "--list", "feature/demo")).toContain(
      "feature/demo",
    );
  });

  test("reports force removal and successful requested branch deletion", () => {
    const { root, feature } = setupRepo();
    writeFileSync(join(feature, "untracked.txt"), "dirty\n");
    const result = runRemove(
      root,
      "feature/demo",
      "--force",
      "--delete-branch",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain(
      `Removed ${feature} [feature/demo]`,
    );
    expect(result.stdout.toString()).toContain("force: yes");
    expect(result.stdout.toString()).toContain("branch deletion: succeeded");
    expect(existsSync(feature)).toBe(false);
  });

  test("reports one primary error and a nonzero exit for a dirty worktree", () => {
    const { root, feature } = setupRepo();
    writeFileSync(join(feature, "untracked.txt"), "dirty\n");
    const result = runRemove(root, "feature/demo");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString().trim().split("\n")).toHaveLength(1);
    expect(result.stderr.toString()).toContain("Use --force");
    expect(existsSync(feature)).toBe(true);
  });
});
