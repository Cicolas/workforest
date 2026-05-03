import { resolve } from "node:path";

import { readManifest, writeManifest } from "./config.ts";
import { discoverRepo, runGit } from "./git.ts";
import { applySharedLinks } from "./shared-links.ts";

export interface CreateResult {
  worktreePath: string;
  branchName: string;
  sharedLinksCreated: number;
  manifestPath: string;
}

export function createWorktree(
  cwd: string,
  folder: string,
  branchName: string,
): CreateResult {
  const { manifestPath, manifest } = readManifest(cwd);
  const worktreePath = resolve(cwd, folder);

  if (!branchName.trim()) {
    throw new Error("Branch name is required.");
  }

  if (!manifest.worktrees.some((entry) => entry.isMain)) {
    throw new Error("Workforest manifest does not contain a main worktree.");
  }

  const addResult = runGit(manifest.repo.root, [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
  ]);

  if (!addResult.success) {
    throw new Error(addResult.stderr || "Failed to create git worktree.");
  }

  const sharedLinksCreated = applySharedLinks(
    manifest.repo.root,
    worktreePath,
    manifest.shared,
  );
  const refreshedRepo = discoverRepo(manifest.repo.root);

  writeManifest(manifestPath, {
    ...manifest,
    repo: {
      name: refreshedRepo.repoName,
      root: refreshedRepo.repoRoot,
    },
    worktrees: refreshedRepo.activeWorktrees,
  });

  return {
    worktreePath,
    branchName,
    sharedLinksCreated,
    manifestPath,
  };
}
