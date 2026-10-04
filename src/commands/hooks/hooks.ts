import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readManifest } from "../../lib/config.ts";
import {
  discoverHooks,
  hookEvents,
  runHooks,
  type HookEvent,
} from "../../lib/hooks.ts";

import { discoverRepo, runGit } from "../../lib/git.ts";
import type { WorktreeEntry } from "../../lib/manifest.ts";
import {
  resolveWorktreeTarget,
  TargetResolutionError,
} from "../../lib/target.ts";

export function listHooks(cwd: string): void {
  const { manifestPath } = readManifest(cwd);
  for (const event of hookEvents) {
    console.log(`${event}:`);
    for (const hook of discoverHooks(dirname(manifestPath), event))
      console.log(`  ${hook.name}`);
  }
}

export interface RunHookOptions {
  script?: string;
  branch?: string;
}
export async function runWorktreeHooks(
  cwd: string,
  eventName: string,
  target: string,
  options: RunHookOptions = {},
): Promise<void> {
  if (!hookEvents.includes(eventName as HookEvent))
    throw new Error(
      `Unsupported hook event '${eventName}'. Expected: ${hookEvents.join(", ")}.`,
    );
  const event = eventName as HookEvent;
  const explicit = event === "pre-create" || event === "post-remove";
  if (!explicit && options.branch !== undefined)
    throw new Error(
      "--branch is supported only for pre-create and post-remove.",
    );
  const { manifestPath, manifest } = readManifest(cwd);
  const inventory = discoverRepo(manifest.repo.root).activeWorktrees;
  let entry: WorktreeEntry | undefined;
  try {
    entry = resolveWorktreeTarget(cwd, target, inventory);
  } catch (error) {
    if (
      !explicit ||
      !(error instanceof TargetResolutionError) ||
      error.code !== "target_not_found"
    )
      throw error;
  }
  const worktreePath = entry ? resolve(entry.path) : resolve(cwd, target);
  if (!explicit && !existsSync(worktreePath))
    throw new Error(`Worktree directory is missing: ${worktreePath}`);
  const discoveredBranch =
    !entry && existsSync(worktreePath)
      ? runGit(worktreePath, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]).stdout.trim() || null
      : null;
  await runHooks(
    {
      event,
      worktreePath,
      branch: options.branch ?? entry?.branch ?? discoveredBranch,
      repoRoot: manifest.repo.root,
      manifestDir: dirname(manifestPath),
    },
    options.script,
  );
}
