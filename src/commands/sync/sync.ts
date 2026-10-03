import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { OperationProgress } from "../../lib/errors.ts";
import { pruneWorktrees, validateSharedRepo } from "../../lib/git.ts";
import type { WorktreeEntry } from "../../lib/manifest.ts";
import {
  applySharedLinks,
  preflightSharedLinks,
  expandSharedLinks,
} from "../../lib/shared-links.ts";
import { mergeWorktreeSettings } from "../../lib/worktree-settings.ts";

export interface SyncOptions {
  refresh?: boolean | string;
}

export interface SyncResult {
  manifestPath: string;
  createdWorktrees: string[];
  removedWorktrees: string[];
  worktrees: WorktreeEntry[];
  sharedLinksCreated: number;
}

function pathSet(worktrees: WorktreeEntry[]): Set<string> {
  return new Set(worktrees.map((entry) => resolve(entry.path)));
}

export function syncWorktrees(
  cwd: string,
  options: SyncOptions = {},
): SyncResult {
  const { manifestPath, manifest } = readManifest(cwd);
  const beforeRepo = validateSharedRepo(manifest);
  expandSharedLinks(
    manifest.repo.root,
    manifest.repo.root,
    manifest.shared,
    new Set(),
  );
  for (const worktree of mergeWorktreeSettings(
    manifest.worktrees,
    beforeRepo.activeWorktrees,
  )) {
    if (!worktree.isMain && existsSync(worktree.path)) {
      preflightSharedLinks(
        manifest.repo.root,
        worktree.path,
        manifest.shared,
        worktree.ignoreShared,
      );
    }
  }
  const beforePaths = pathSet(manifest.worktrees);

  const progress = new OperationProgress();
  try {
    const currentRepo = pruneWorktrees(
      manifest.repo.root,
      progress.record,
      beforeRepo,
    );
    const mergedWorktrees = mergeWorktreeSettings(
      manifest.worktrees,
      currentRepo.activeWorktrees,
    );

    let sharedLinksCreated = 0;
    for (const worktree of mergedWorktrees) {
      if (worktree.isMain || !existsSync(worktree.path)) {
        continue;
      }

      sharedLinksCreated += applySharedLinks(
        manifest.repo.root,
        worktree.path,
        manifest.shared,
        worktree.ignoreShared,
        options.refresh,
        progress.record,
      );
    }

    const afterPaths = pathSet(mergedWorktrees);
    const createdWorktrees = mergedWorktrees
      .map((entry) => entry.path)
      .filter((path) => !beforePaths.has(resolve(path)));
    const removedWorktrees = manifest.worktrees
      .map((entry) => entry.path)
      .filter((path) => !afterPaths.has(resolve(path)));

    writeManifest(
      manifestPath,
      {
        ...manifest,
        repo: {
          name: currentRepo.repoName,
          root: currentRepo.repoRoot,
        },
        worktrees: mergedWorktrees,
      },
      progress.recordManifest,
    );

    return {
      manifestPath,
      createdWorktrees,
      removedWorktrees,
      worktrees: mergedWorktrees,
      sharedLinksCreated,
    };
  } catch (error) {
    throw progress.failure(
      error,
      manifestPath,
      "Correct the reported problem, inspect any recovery artifacts, and run wf sync again to reconcile sharing and inventory. If you requested copy refresh, repeat wf sync --refresh with the same selection after recovery.",
    );
  }
}
