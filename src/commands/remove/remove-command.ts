import type { Command } from "commander";

import { formatError } from "../../lib/errors.ts";
import { removeWorktree, type RemoveOptions } from "./remove.ts";

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove")
    .description("Remove a non-main worktree and update the manifest.")
    .argument("<target>", "worktree path or branch name")
    .option("--force", "allow removal of a dirty worktree")
    .option("--delete-branch", "safely delete the associated local branch")
    .action((target: string, options: RemoveOptions) => {
      try {
        const result = removeWorktree(process.cwd(), target, options);
        const branch = result.branchName ?? "detached";
        const deletion = !result.branchDeletionRequested
          ? "not requested"
          : result.branchDeleted
            ? "succeeded"
            : "skipped (detached worktree)";
        const missing = result.alreadyMissing ? ", path already missing" : "";
        console.log(
          `Removed ${result.worktreePath} [${branch}] (force: ${result.forceUsed ? "yes" : "no"}, branch deletion: ${deletion}${missing}, manifest updated at ${result.manifestPath})`,
        );
      } catch (error) {
        console.error(formatError(error));
        process.exitCode = 1;
      }
    });
}
