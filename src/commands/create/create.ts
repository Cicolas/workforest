import { resolve } from "node:path";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { discoverRepo, runGit, validateSharedRepo } from "../../lib/git.ts";
import {
  applySharedLinks,
  preflightSharedLinks,
} from "../../lib/shared-links.ts";
import { mergeWorktreeSettings } from "../../lib/worktree-settings.ts";

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

  validateSharedRepo(manifest);
  preflightSharedLinks(
    manifest.repo.root,
    worktreePath,
    manifest.shared,
    manifest.worktrees.find((entry) => resolve(entry.path) === worktreePath)
      ?.ignoreShared,
  );

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
    manifest.worktrees.find((entry) => resolve(entry.path) === worktreePath)
      ?.ignoreShared,
  );
  const refreshedRepo = discoverRepo(manifest.repo.root);

  writeManifest(manifestPath, {
    ...manifest,
    repo: {
      name: refreshedRepo.repoName,
      root: refreshedRepo.repoRoot,
    },
    worktrees: mergeWorktreeSettings(
      manifest.worktrees,
      refreshedRepo.activeWorktrees,
    ),
  });

  return {
    worktreePath,
    branchName,
    sharedLinksCreated,
    manifestPath,
  };
}
