import type { Command } from "commander";

import { colors } from "../../lib/colors.ts";
import { formatError } from "../../lib/errors.ts";
import { formatWorktreeList, listWorktrees } from "./list.ts";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List manifest worktrees and whether their paths exist.")
    .option("--json", "print worktrees as JSON")
    .action((options: { json?: boolean }) => {
      try {
        const worktrees = listWorktrees(process.cwd());
        console.log(
          options.json
            ? JSON.stringify(worktrees, null, 2)
            : formatWorktreeList(worktrees, true),
        );
      } catch (error) {
        console.error(colors.error(formatError(error)));
        process.exitCode = 1;
      }
    });
}
