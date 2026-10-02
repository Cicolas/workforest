import { Command, CommanderError } from "commander";

import { registerCreateCommand } from "./commands/create/create-command.ts";
import { registerInitCommand } from "./commands/init/init-command.ts";
import { registerListCommand } from "./commands/list/list-command.ts";
import { registerRemoveCommand } from "./commands/remove/remove-command.ts";
import { registerStatusCommand } from "./commands/status/status-command.ts";
import { registerSyncCommand } from "./commands/sync/sync-command.ts";
import { colors, supportsColor } from "./lib/colors.ts";
import { reportAndExit } from "./lib/errors.ts";
import { configureColoredHelp } from "./lib/help.ts";

export function buildProgram(): Command {
  const program = new Command();
  configureColoredHelp(program);
  program.configureOutput({
    getOutHasColors: () => supportsColor(process.stdout),
    getErrHasColors: () => supportsColor(process.stderr),
    outputError: (message, write) => write(colors.error(message)),
  });

  program
    .name("wf")
    .description("CLI helpers for managing Git worktree development flows.")
    .showHelpAfterError();

  registerInitCommand(program);
  registerCreateCommand(program);
  registerSyncCommand(program);
  registerListCommand(program);
  registerStatusCommand(program);
  registerRemoveCommand(program);

  for (const command of program.commands) {
    if (["list", "status", "remove"].includes(command.name())) {
      command.showHelpAfterError(false);
    }
  }

  return program;
}

export function run(argv = process.argv): void {
  const program = buildProgram();
  for (const command of [program, ...program.commands]) {
    command.exitOverride();
  }

  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }

  try {
    program.parse(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      const statusFailure = argv[2] === "status" && error.exitCode !== 0;
      process.exitCode = statusFailure ? 2 : error.exitCode;
      if (statusFailure && argv.includes("--json")) {
        console.log(JSON.stringify({ level: "error", findings: [] }, null, 2));
      }
      return;
    }
    reportAndExit(error);
  }
}

if (import.meta.main) {
  run();
}
