import { Command, CommanderError } from "commander";

import { createWorktree } from "./create.ts";
import { initWorkforest } from "./init.ts";
import { registerListCommand } from "./list-command.ts";
import { registerRemoveCommand } from "./remove-command.ts";
import { registerStatusCommand } from "./status-command.ts";
import { syncWorktrees } from "./sync.ts";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function reportAndExit(error: unknown): never {
  console.error(formatError(error));
  process.exit(1);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("wf")
    .description("CLI helpers for managing Git worktree development flows.")
    .showHelpAfterError();

  program
    .command("init")
    .description(
      "Create a workforest.yaml manifest for the current repository.",
    )
    .argument("[main-folder]", "folder containing the main git worktree")
    .action((mainFolder?: string) => {
      try {
        const result = initWorkforest(process.cwd(), mainFolder);
        const discoveryLabel = result.gitDiscovered
          ? "git metadata discovered"
          : "scaffolded without git metadata";
        console.log(`Created ${result.manifestPath} (${discoveryLabel})`);
      } catch (error) {
        reportAndExit(error);
      }
    });

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
          `Created ${result.worktreePath} on ${result.branchName} (${result.sharedLinksCreated} shared link(s), manifest updated at ${result.manifestPath})`,
        );
      } catch (error) {
        reportAndExit(error);
      }
    });

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
