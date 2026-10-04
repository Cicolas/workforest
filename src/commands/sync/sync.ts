import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { readManifest, writeManifest } from "../../lib/config.ts";
import { OperationProgress } from "../../lib/errors.ts";
import { pruneWorktrees, validateSharedRepo } from "../../lib/git.ts";
import { discoverHooks, runHooks, type HookEvent } from "../../lib/hooks.ts";
import type { WorktreeEntry } from "../../lib/manifest.ts";
import {
  applySharedLinks,
  preflightSharedLinks,
  expandSharedLinks,
} from "../../lib/shared-links.ts";
import { mergeWorktreeSettings } from "../../lib/worktree-settings.ts";

export interface SyncOptions {
  refresh?: boolean | string;
  skipHooks?: boolean;
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

export async function syncWorktrees(
  cwd: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
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

    const runEvent = async (event: HookEvent, worktree: WorktreeEntry) => {
      if (
        options.skipHooks ||
        discoverHooks(dirname(manifestPath), event).length === 0
      )
        return;
      try {
        await runHooks({
          event,
          worktreePath: worktree.path,
          branch: worktree.branch,
          repoRoot: currentRepo.repoRoot,
          manifestDir: dirname(manifestPath),
        });
        progress.record(
          `Completed ${event} hooks for ${worktree.path}; script effects remain`,
        );
      } catch (error) {
        progress.record(
          `${event} hook effects may remain for ${worktree.path}`,
          false,
        );
        throw error;
      }
    };

    let sharedLinksCreated = 0;
    for (const worktree of mergedWorktrees) {
      if (worktree.isMain || !existsSync(worktree.path)) {
        continue;
      }

      await runEvent("pre-sync", worktree);
      sharedLinksCreated += applySharedLinks(
        manifest.repo.root,
        worktree.path,
        manifest.shared,
        worktree.ignoreShared,
        options.refresh,
        progress.record,
      );
      await runEvent("post-sync", worktree);
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
      "Correct the reported problem, inspect any recovery artifacts, and run wf sync --skip-hooks to reconcile sharing and inventory without repeating hook effects. Correct failing scripts and retry them with wf hooks run. If you requested copy refresh, repeat wf sync --refresh with the same selection after recovery.",
    );
  }
}
