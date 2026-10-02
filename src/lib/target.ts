import { resolve } from "node:path";

import type { WorktreeEntry } from "./manifest.ts";

export class TargetResolutionError extends Error {
  constructor(
    public readonly code: "target_ambiguous" | "target_not_found",
    message: string,
    public readonly matches: WorktreeEntry[] = [],
  ) {
    super(message);
    this.name = "TargetResolutionError";
  }
}

export function resolveWorktreeTarget(
  cwd: string,
  target: string,
  worktrees: WorktreeEntry[],
): WorktreeEntry {
  const entries = [
    ...new Map(worktrees.map((entry) => [resolve(entry.path), entry])).values(),
  ];
  const targetPath = resolve(cwd, target);
  const pathMatches = entries.filter(
    (entry) => resolve(entry.path) === targetPath,
  );
  const matches =
    pathMatches.length > 0
      ? pathMatches
      : entries.filter((entry) => entry.branch === target);

  if (matches.length === 0) {
    throw new TargetResolutionError(
      "target_not_found",
      `No worktree matches target: ${target}`,
    );
  }

  if (matches.length > 1) {
    throw new TargetResolutionError(
      "target_ambiguous",
      `Ambiguous worktree target '${target}': ${matches.map((entry) => resolve(entry.path)).join(", ")}`,
      matches,
    );
  }

  return matches[0];
}
