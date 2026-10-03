import { resolve } from "node:path";

import type { WorktreeEntry } from "./manifest.ts";

export function mergeWorktreeSettings(
  currentWorktrees: WorktreeEntry[],
  discoveredWorktrees: WorktreeEntry[],
): WorktreeEntry[] {
  const currentByPath = new Map(
    currentWorktrees.map((entry) => [resolve(entry.path), entry]),
  );

  return discoveredWorktrees.map((entry) => {
    const existingEntry = currentByPath.get(resolve(entry.path));

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
