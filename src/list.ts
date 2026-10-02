import { existsSync } from "node:fs";

import { readManifest } from "./config.ts";

export interface ListedWorktree {
  path: string;
  branch: string | null;
  isMain: boolean;
  exists: boolean;
}

export function listWorktrees(cwd: string): ListedWorktree[] {
  const { manifest } = readManifest(cwd);

  return manifest.worktrees.map((worktree) => ({
    path: worktree.path,
    branch: worktree.branch,
    isMain: worktree.isMain,
    exists: existsSync(worktree.path),
  }));
}

export function formatWorktreeList(worktrees: ListedWorktree[]): string {
  const rows = [
    ["PATH", "BRANCH", "STATE", "ROLE"],
    ...worktrees.map((worktree) => [
      worktree.path,
      worktree.branch ?? "detached",
      worktree.exists ? "present" : "missing",
      worktree.isMain ? "main" : "worktree",
    ]),
  ];
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => row[index].length)),
  );

  return rows
    .map((row) =>
      row
        .map((value, index) =>
          index === row.length - 1 ? value : value.padEnd(widths[index]),
        )
        .join("  "),
    )
    .join("\n");
}
