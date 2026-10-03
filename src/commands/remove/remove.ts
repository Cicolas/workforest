import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { OperationProgress } from "../../lib/errors.ts";
import { discoverRepo, pruneWorktrees, runGit } from "../../lib/git.ts";
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

export function removeWorktree(
  cwd: string,
  target: string,
  options: RemoveOptions = {},
): RemoveResult {
  const { manifestPath, manifest } = readManifest(cwd);
  // Inspect registrations before pruning: the inventory is a cache, and a
  // worktree may have switched branches (or detached) since the last sync.
  const discovery = discoverRepo(manifest.repo.root);
  const liveByPath = new Map(
    discovery.activeWorktrees.map((entry) => [resolve(entry.path), entry]),
  );
  const entriesByPath = new Map(
    manifest.worktrees.map((entry) => [resolve(entry.path), entry]),
  );
  for (const [path, entry] of liveByPath) {
    entriesByPath.set(path, entry);
  }

  if (!entriesByPath.has(resolve(cwd, target))) {
    const cachedMatches = manifest.worktrees.filter(
      (entry) => entry.branch === target,
    );
    // Retain the existing ambiguity guard even when cached entries are stale.
    if (cachedMatches.length > 1) {
      resolveWorktreeTarget(cwd, target, manifest.worktrees);
    }
    const obsolete = cachedMatches.find((entry) => {
      const live = liveByPath.get(resolve(entry.path));
      return live !== undefined && live.branch !== target;
    });
    if (obsolete) {
      const live = liveByPath.get(resolve(obsolete.path))!;
      throw new Error(
        `Obsolete branch association '${target}' for ${resolve(obsolete.path)}: Git now reports ${live.branch ?? "detached HEAD"}. Use the worktree path or run wf sync before choosing a branch target.`,
      );
    }
  }

  const worktree = resolveWorktreeTarget(cwd, target, [
    ...entriesByPath.values(),
  ]);
  const worktreePath = resolve(worktree.path);

  if (
    worktree.isMain ||
    manifest.worktrees.some(
      (entry) => resolve(entry.path) === worktreePath && entry.isMain,
    ) ||
    worktreePath === discovery.repoRoot
  ) {
    throw new Error(`Cannot remove the main worktree: ${worktreePath}`);
  }

  const alreadyMissing = !existsSync(worktreePath);
  const forceUsed = !alreadyMissing && Boolean(options.force);

  if (!alreadyMissing) {
    const status = runGit(worktreePath, ["status", "--porcelain"]);
    if (!status.success) {
      throw new Error(status.stderr || "Failed to check worktree status.");
    }
    if (status.stdout && !options.force) {
      throw new Error(
        `Worktree has uncommitted changes: ${worktreePath}. Use --force to remove it.`,
      );
    }
  }

  const progress = new OperationProgress();
  let branchDeletionError: string | undefined;
  try {
    if (alreadyMissing) {
      pruneWorktrees(manifest.repo.root, progress.record);
    } else {
      const removal = runGit(manifest.repo.root, [
        "worktree",
        "remove",
        ...(options.force ? ["--force"] : []),
        "--",
        worktreePath,
      ]);
      if (!removal.success) {
        progress.record(
          `Git removal did not finish at ${worktreePath}; inspect remaining contents and Git registration before recovery`,
          false,
        );
        throw new Error(removal.stderr || "Failed to remove git worktree.");
      }
      progress.record(`Removed worktree ${worktreePath}`);
    }

    let branchDeleted = false;
    if (options.deleteBranch && worktree.branch !== null) {
      const deletion = runGit(manifest.repo.root, [
        "branch",
        "-d",
        "--",
        worktree.branch,
      ]);
      branchDeleted = deletion.success;
      if (branchDeleted) progress.record(`Deleted branch ${worktree.branch}`);
      if (!deletion.success) {
        branchDeletionError =
          deletion.stderr || `Failed to delete branch ${worktree.branch}.`;
      }
    }

    if (!alreadyMissing) {
      pruneWorktrees(manifest.repo.root, progress.record);
    }

    const refreshedRepo = discoverRepo(manifest.repo.root);
    writeManifest(
      manifestPath,
      {
        ...manifest,
        repo: { name: refreshedRepo.repoName, root: refreshedRepo.repoRoot },
        worktrees: mergeWorktreeSettings(
          manifest.worktrees,
          refreshedRepo.activeWorktrees,
        ),
      },
      progress.recordManifest,
    );

    if (branchDeletionError) {
      const detail = branchDeletionError;
      branchDeletionError = undefined;
      throw new Error(
        `Removed ${worktreePath} and updated the manifest, but branch deletion failed: ${detail}`,
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
  } catch (error) {
    const detail = branchDeletionError
      ? new Error(
          `${error instanceof Error ? error.message : String(error)}; branch deletion failed: ${branchDeletionError}`,
          { cause: error },
        )
      : error;
    throw progress.failure(
      detail,
      manifestPath,
      "Correct the reported filesystem or persistence problem and run wf sync to reconcile the manifest with Git. A removed worktree is not restored. Inspect any retained branch and merge its history before retrying safe branch deletion separately.",
    );
  }
}
