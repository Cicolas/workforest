import type { Command } from "commander";

import { formatError } from "../../lib/errors.ts";
import {
  statusErrorResult,
  statusWorktrees,
  type StatusResult,
} from "./status.ts";

function printStatus(result: StatusResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`STATUS ${result.level} (${result.findings.length} finding(s))`);
  for (const finding of result.findings) {
    console.log(`- ${finding.path}: ${finding.code}`);
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "Check worktree registrations and shared links and copies without modifying them.",
    )
    .argument("[target]", "worktree path or branch name to inspect")
    .option("--json", "print a structured status result")
    .action((target: string | undefined, options: { json?: boolean }) => {
      try {
        const result = statusWorktrees(process.cwd(), target);
        printStatus(result, options.json ?? false);
        process.exitCode = result.level === "ok" ? 0 : 1;
      } catch (error) {
        const result = statusErrorResult(error);
        printStatus(result, options.json ?? false);
        console.error(formatError(error));
        process.exitCode = 2;
      }
    });
}
