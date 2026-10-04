import { describe, expect, test } from "bun:test";
import { CommanderError } from "commander";

import { buildProgram } from "../src/cli.ts";

function createTestProgram(): {
  program: ReturnType<typeof buildProgram>;
  readStdout: () => string;
  readStderr: () => string;
} {
  let stdout = "";
  let stderr = "";

  const program = buildProgram();
  const output = {
    writeOut: (message: string) => {
      stdout += message;
    },
    writeErr: (message: string) => {
      stderr += message;
    },
  };
  program.configureOutput(output);
  program.exitOverride();
  for (const command of program.commands) {
    command.configureOutput(output);
    command.exitOverride();
  }

  return {
    program,
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

function ignoreCommanderExit(error: unknown): void {
  if (error instanceof CommanderError) {
    return;
  }

  throw error;
}

describe("buildProgram", () => {
  test("prints top-level help with commander-generated command listings", () => {
    const { program, readStdout } = createTestProgram();

    try {
      program.parse(["node", "wf", "--help"]);
    } catch (error) {
      ignoreCommanderExit(error);
    }

    const stdout = readStdout();
    expect(stdout).toContain("Usage: wf [options] [command]");
    expect(stdout).toContain("init [main-folder]");
    expect(stdout).toContain("create [options] <folder> <branch-name>");
    expect(stdout).toContain("sync");
  });

  test("prints command help for create", () => {
    const { program, readStdout } = createTestProgram();

    try {
      program.parse(["node", "wf", "create", "--help"]);
    } catch (error) {
      ignoreCommanderExit(error);
    }

    const stdout = readStdout();
    expect(stdout).toContain(
      "Usage: wf create [options] <folder> <branch-name>",
    );
    expect(stdout).toContain("folder to create for the new worktree");
    expect(stdout).toContain("new branch name for the worktree");
  });

  test("shows generated help after a missing required create argument", () => {
    const { program, readStderr } = createTestProgram();

    try {
      program.parse(["node", "wf", "create"]);
    } catch (error) {
      ignoreCommanderExit(error);
    }

    const stderr = readStderr();
    expect(stderr).toContain("error: missing required argument 'folder'");
    expect(stderr).toContain(
      "Usage: wf create [options] <folder> <branch-name>",
    );
  });
});
