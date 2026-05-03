import { existsSync } from "node:fs";

import { readManifest, writeManifest } from "./config.ts";
import { discoverRepo, runGit } from "./git.ts";
import type { WorktreeEntry } from "./manifest.ts";
import { applySharedLinks } from "./shared-links.ts";

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

  let sharedLinksCreated = 0;
  for (const worktree of currentRepo.activeWorktrees) {
    if (worktree.isMain || !existsSync(worktree.path)) {
      continue;
    }

    sharedLinksCreated += applySharedLinks(
      manifest.repo.root,
      worktree.path,
      manifest.shared,
    );
  }

  const afterPaths = pathSet(currentRepo.activeWorktrees);
  const createdWorktrees = currentRepo.activeWorktrees
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
    worktrees: currentRepo.activeWorktrees,
  });

  return {
    manifestPath,
    createdWorktrees,
    removedWorktrees,
    worktrees: currentRepo.activeWorktrees,
    sharedLinksCreated,
  };
}
