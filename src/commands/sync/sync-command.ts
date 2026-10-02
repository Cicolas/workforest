import type { Command } from "commander";

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
          `Synced ${result.worktrees.length} worktree(s) (${result.createdWorktrees.length} created, ${result.removedWorktrees.length} removed, ${result.sharedLinksCreated} shared path(s) updated)`,
        );

        for (const worktree of result.worktrees) {
          const branchLabel = worktree.branch ?? "detached";
          const mainLabel = worktree.isMain ? " main" : "";
          console.log(`- ${worktree.path} [${branchLabel}]${mainLabel}`);
        }
      } catch (error) {
        reportAndExit(error);
      }
    });
}
