import type { Command } from "commander";

import { colors } from "../../lib/colors.ts";
import { reportAndExit } from "../../lib/errors.ts";
import { createWorktree, type CreateOptions } from "./create.ts";

export function registerCreateCommand(program: Command): void {
  program
    .command("create")
    .description(
      "Create a new git worktree and update the workforest manifest.",
    )
    .argument("<folder>", "folder to create for the new worktree")
    .argument("<branch-name>", "new branch name for the worktree")
    .option("--skip-hooks", "skip Workforest lifecycle hooks")
    .action(
      async (folder: string, branchName: string, options: CreateOptions) => {
        try {
          const result = await createWorktree(
            process.cwd(),
            folder,
            branchName,
            options,
          );
          console.log(
            `${colors.success("Created")} ${result.worktreePath} on ${result.branchName} (${result.sharedLinksCreated} shared path(s), manifest updated at ${result.manifestPath})`,
          );
        } catch (error) {
          reportAndExit(error);
        }
      },
    );
}
