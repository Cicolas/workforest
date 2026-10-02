import type { Command } from "commander";

import { reportAndExit } from "../../lib/errors.ts";
import { syncWorktrees } from "./sync.ts";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description(
      "Prune stale worktrees, refresh the manifest, and restore shared links.",
    )
    .action(() => {
      try {
        const result = syncWorktrees(process.cwd());
        console.log(
          `Synced ${result.worktrees.length} worktree(s) (${result.createdWorktrees.length} created, ${result.removedWorktrees.length} removed, ${result.sharedLinksCreated} shared link(s) updated)`,
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
