import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { discoverRepo, runGit, validateSharedRepo } from "../../lib/git.ts";
import type { WorktreeEntry } from "../../lib/manifest.ts";
import { applySharedLinks } from "../../lib/shared-links.ts";
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
  validateSharedRepo(manifest);
  const beforePaths = pathSet(manifest.worktrees);

  const pruneResult = runGit(manifest.repo.root, [
    "worktree",
    "prune",
    "--expire",
    "now",
  ]);
  if (!pruneResult.success) {
    throw new Error(pruneResult.stderr || "Failed to prune git worktrees.");
  }

  const currentRepo = discoverRepo(manifest.repo.root);
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
    );
  }

  const afterPaths = pathSet(mergedWorktrees);
  const createdWorktrees = mergedWorktrees
    .map((entry) => entry.path)
    .filter((path) => !beforePaths.has(resolve(path)));
  const removedWorktrees = manifest.worktrees
    .map((entry) => entry.path)
    .filter((path) => !afterPaths.has(resolve(path)));

  writeManifest(manifestPath, {
    ...manifest,
    repo: {
      name: currentRepo.repoName,
      root: currentRepo.repoRoot,
    },
    worktrees: mergedWorktrees,
  });

  return {
    manifestPath,
    createdWorktrees,
    removedWorktrees,
    worktrees: mergedWorktrees,
    sharedLinksCreated,
  };
}
