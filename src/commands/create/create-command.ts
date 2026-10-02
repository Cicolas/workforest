import type { Command } from "commander";

import { reportAndExit } from "../../lib/errors.ts";
import { createWorktree } from "./create.ts";

export function registerCreateCommand(program: Command): void {
  program
    .command("create")
    .description(
      "Create a new git worktree and update the workforest manifest.",
    )
    .argument("<folder>", "folder to create for the new worktree")
    .argument("<branch-name>", "new branch name for the worktree")
    .action((folder: string, branchName: string) => {
      try {
        const result = createWorktree(process.cwd(), folder, branchName);
        console.log(
          `Created ${result.worktreePath} on ${result.branchName} (${result.sharedLinksCreated} shared path(s), manifest updated at ${result.manifestPath})`,
        );
      } catch (error) {
        reportAndExit(error);
      }
    });
}
