import { existsSync } from "node:fs";

import { colors } from "../../lib/colors.ts";
import { readManifest } from "../../lib/config.ts";

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

export function formatWorktreeList(
  worktrees: ListedWorktree[],
  colorize = false,
): string {
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
    .map((row, rowIndex) =>
      row
        .map((value, index) => {
          const padded =
            index === row.length - 1 ? value : value.padEnd(widths[index]);
          if (!colorize) {
            return padded;
          }
          if (rowIndex === 0) {
            return colors.heading(padded);
          }

          const worktree = worktrees[rowIndex - 1];
          if (index === 1) {
            return worktree.branch === null
              ? colors.muted(padded)
              : colors.info(padded);
          }
          if (index === 2) {
            return worktree.exists
              ? colors.success(padded)
              : colors.warning(padded);
          }
          if (index === 3) {
            return worktree.isMain
              ? colors.heading(padded)
              : colors.muted(padded);
          }
          return padded;
        })
        .join("  "),
    )
    .join("\n");
}
