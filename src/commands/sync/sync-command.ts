import type { Command } from "commander";

import { colors } from "../../lib/colors.ts";
import { reportAndExit } from "../../lib/errors.ts";
import { syncWorktrees, type SyncOptions } from "./sync.ts";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description(
      "Prune stale worktrees, refresh the manifest, and restore shared links and copies.",
    )
    .option(
      "--refresh [path]",
      "replace all shared copies, or only the given source or target path",
    )
    .action((options: SyncOptions) => {
      try {
        const result = syncWorktrees(process.cwd(), options);
        console.log(
          `${colors.success("Synced")} ${result.worktrees.length} worktree(s) (${result.createdWorktrees.length} created, ${result.removedWorktrees.length} removed, ${result.sharedLinksCreated} shared path(s) updated)`,
        );

        for (const worktree of result.worktrees) {
          const branchLabel =
            worktree.branch === null
              ? colors.muted("detached")
              : colors.info(worktree.branch);
          const mainLabel = worktree.isMain ? ` ${colors.heading("main")}` : "";
          console.log(
            `${colors.muted("-")} ${worktree.path} [${branchLabel}]${mainLabel}`,
          );
        }
      } catch (error) {
        reportAndExit(error);
      }
    });
}
