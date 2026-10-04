import type { Command } from "commander";
import { reportAndExit } from "../../lib/errors.ts";
import { listHooks, runWorktreeHooks, type RunHookOptions } from "./hooks.ts";

export function registerHooksCommand(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Inspect and run shared worktree hooks.");
  hooks
    .command("list")
    .description("List executable scripts grouped by hook event.")
    .action(() => {
      try {
        listHooks(process.cwd());
      } catch (error) {
        reportAndExit(error);
      }
    });
  hooks
    .command("run")
    .description("Run hooks without repeating a worktree operation.")
    .argument("<event>", "hook event to run")
    .argument(
      "<target>",
      "worktree path or branch; explicit paths for pre-create/post-remove",
    )
    .option("--script <filename>", "run only one executable script")
    .option("--branch <name>", "branch context for pre-create/post-remove")
    .action(async (event: string, target: string, options: RunHookOptions) => {
      try {
        await runWorktreeHooks(process.cwd(), event, target, options);
      } catch (error) {
        reportAndExit(error);
      }
    });
}
