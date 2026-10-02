import { existsSync } from "node:fs";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { discoverRepo, runGit } from "../../lib/git.ts";
import type { WorktreeEntry } from "../../lib/manifest.ts";
import { applySharedLinks } from "../../lib/shared-links.ts";

export interface SyncResult {
  manifestPath: string;
  createdWorktrees: string[];
  removedWorktrees: string[];
  worktrees: WorktreeEntry[];
  sharedLinksCreated: number;
}

function pathSet(worktrees: WorktreeEntry[]): Set<string> {
  return new Set(worktrees.map((entry) => entry.path));
}

function mergeWorktreeSettings(
  currentWorktrees: WorktreeEntry[],
  discoveredWorktrees: WorktreeEntry[],
): WorktreeEntry[] {
  const currentByPath = new Map(
    currentWorktrees.map((entry) => [entry.path, entry]),
  );

  return discoveredWorktrees.map((entry) => {
    const existingEntry = currentByPath.get(entry.path);

    if (
      !existingEntry?.ignoreShared ||
      existingEntry.ignoreShared.length === 0
    ) {
      return entry;
    }

    return {
      ...entry,
      ignoreShared: [...existingEntry.ignoreShared],
    };
  });
}

export function syncWorktrees(cwd: string): SyncResult {
  const { manifestPath, manifest } = readManifest(cwd);
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
    );
  }

  const afterPaths = pathSet(mergedWorktrees);
  const createdWorktrees = mergedWorktrees
    .map((entry) => entry.path)
    .filter((path) => !beforePaths.has(path));
  const removedWorktrees = manifest.worktrees
    .map((entry) => entry.path)
    .filter((path) => !afterPaths.has(path));

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
