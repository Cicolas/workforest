import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { OperationProgress } from "../../lib/errors.ts";
import { discoverRepo, runGit, validateSharedRepo } from "../../lib/git.ts";
import {
  applySharedLinks,
  preflightSharedLinks,
} from "../../lib/shared-links.ts";
import { discoverHooks, runHooks } from "../../lib/hooks.ts";
import { mergeWorktreeSettings } from "../../lib/worktree-settings.ts";

export interface CreateResult {
  worktreePath: string;
  branchName: string;
  sharedLinksCreated: number;
  manifestPath: string;
}

export interface CreateOptions {
  skipHooks?: boolean;
}

export async function createWorktree(
  cwd: string,
  folder: string,
  branchName: string,
  options: CreateOptions = {},
): Promise<CreateResult> {
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

  const progress = new OperationProgress();
  const branchExisted = runGit(manifest.repo.root, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}`,
  ]).success;
  const pathExisted = existsSync(worktreePath);
  const context = {
    worktreePath,
    branch: branchName,
    repoRoot: manifest.repo.root,
    manifestDir: dirname(manifestPath),
  };
  const hooks = async (event: "pre-create" | "post-create") => {
    if (
      options.skipHooks ||
      discoverHooks(context.manifestDir, event).length === 0
    )
      return;
    try {
      await runHooks({ ...context, event });
    } catch (error) {
      progress.record(
        `Hook effects may remain from ${event} at ${worktreePath}`,
        false,
      );
      throw error;
    }
    progress.record(`Completed ${event} hooks at ${worktreePath}`);
  };
  try {
    await hooks("pre-create");
    const addResult = runGit(manifest.repo.root, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
    ]);

    if (!addResult.success) {
      if (
        !branchExisted &&
        runGit(manifest.repo.root, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branchName}`,
        ]).success
      ) {
        progress.record(`Created branch ${branchName}`);
      }
      if (!pathExisted && existsSync(worktreePath)) {
        progress.record(
          `Created worktree directory ${worktreePath}; inspect its Git registration`,
        );
      }
      throw new Error(addResult.stderr || "Failed to create git worktree.");
    }

    progress.record(`Created branch ${branchName}`);
    progress.record(`Created worktree ${worktreePath}`);
    const sharedLinksCreated = applySharedLinks(
      manifest.repo.root,
      worktreePath,
      manifest.shared,
      manifest.worktrees.find((entry) => resolve(entry.path) === worktreePath)
        ?.ignoreShared,
      false,
      progress.record,
    );
    const refreshedRepo = discoverRepo(manifest.repo.root);

    writeManifest(
      manifestPath,
      {
        ...manifest,
        repo: {
          name: refreshedRepo.repoName,
          root: refreshedRepo.repoRoot,
        },
        worktrees: mergeWorktreeSettings(
          manifest.worktrees,
          refreshedRepo.activeWorktrees,
        ),
      },
      progress.recordManifest,
    );
    await hooks("post-create");
    return {
      worktreePath,
      branchName,
      sharedLinksCreated,
      manifestPath,
    };
  } catch (error) {
    throw progress.failure(
      error,
      manifestPath,
      "Correct the reported problem and run wf sync --skip-hooks to adopt the existing Git worktree and reconcile sharing and inventory. Do not repeat wf create for a branch or worktree that already exists. If only the branch exists, inspect git worktree list and use git worktree add with that existing branch to finish registration.",
    );
  }
}
