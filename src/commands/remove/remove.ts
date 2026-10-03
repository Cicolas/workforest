import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { discoverRepo, runGit } from "../../lib/git.ts";
import { resolveWorktreeTarget } from "../../lib/target.ts";
import { mergeWorktreeSettings } from "../../lib/worktree-settings.ts";

export interface RemoveOptions {
  force?: boolean;
  deleteBranch?: boolean;
}

export interface RemoveResult {
  worktreePath: string;
  branchName: string | null;
  forceUsed: boolean;
  alreadyMissing: boolean;
  branchDeletionRequested: boolean;
  branchDeleted: boolean;
  manifestPath: string;
}

function pruneWorktrees(repoRoot: string): void {
  const result = runGit(repoRoot, ["worktree", "prune", "--expire", "now"]);
  if (!result.success) {
    throw new Error(result.stderr || "Failed to prune git worktrees.");
  }
}

export function removeWorktree(
  cwd: string,
  target: string,
  options: RemoveOptions = {},
): RemoveResult {
  const { manifestPath, manifest } = readManifest(cwd);
  const worktree = resolveWorktreeTarget(cwd, target, manifest.worktrees);
  const worktreePath = resolve(worktree.path);

  if (worktree.isMain || worktreePath === resolve(manifest.repo.root)) {
    throw new Error(`Cannot remove the main worktree: ${worktreePath}`);
  }

  const alreadyMissing = !existsSync(worktreePath);
  const forceUsed = !alreadyMissing && Boolean(options.force);

  if (alreadyMissing) {
    pruneWorktrees(manifest.repo.root);
  } else {
    const status = runGit(worktreePath, ["status", "--porcelain"]);
    if (!status.success) {
      throw new Error(status.stderr || "Failed to check worktree status.");
    }
    if (status.stdout && !options.force) {
      throw new Error(
        `Worktree has uncommitted changes: ${worktreePath}. Use --force to remove it.`,
      );
    }

    const removal = runGit(manifest.repo.root, [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      "--",
      worktreePath,
    ]);
    if (!removal.success) {
      throw new Error(removal.stderr || "Failed to remove git worktree.");
    }
  }

  let branchDeleted = false;
  let branchDeletionError: string | undefined;
  if (options.deleteBranch && worktree.branch !== null) {
    const deletion = runGit(manifest.repo.root, [
      "branch",
      "-d",
      "--",
      worktree.branch,
    ]);
    branchDeleted = deletion.success;
    if (!deletion.success) {
      branchDeletionError =
        deletion.stderr || `Failed to delete branch ${worktree.branch}.`;
    }
  }

  if (!alreadyMissing) {
    pruneWorktrees(manifest.repo.root);
  }

  const refreshedRepo = discoverRepo(manifest.repo.root);
  writeManifest(manifestPath, {
    ...manifest,
    repo: { name: refreshedRepo.repoName, root: refreshedRepo.repoRoot },
    worktrees: mergeWorktreeSettings(
      manifest.worktrees,
      refreshedRepo.activeWorktrees,
    ),
  });

  if (branchDeletionError) {
    throw new Error(
      `Removed ${worktreePath} and updated the manifest, but branch deletion failed: ${branchDeletionError}`,
    );
  }

  return {
    worktreePath,
    branchName: worktree.branch,
    forceUsed,
    alreadyMissing,
    branchDeletionRequested: Boolean(options.deleteBranch),
    branchDeleted,
    manifestPath,
  };
}
