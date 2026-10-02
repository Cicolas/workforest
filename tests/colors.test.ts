import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { writeManifest } from "../src/lib/config.ts";

const cliPath = resolve(import.meta.dir, "../src/cli.ts");
const colorsPath = resolve(import.meta.dir, "../src/lib/colors.ts");
const tempDirs: string[] = [];

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "workforest-colors-"));
  tempDirs.push(cwd);
  return cwd;
}

function run(
  cwd: string,
  args: string[],
  variables: Record<string, string> = {},
) {
  const env = { ...process.env };
  for (const name of ["FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS"]) {
    delete env[name];
  }
  return Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd,
    env: { ...env, TERM: "xterm-256color", ...variables },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("CLI colors", () => {
  test("uses stdout and stderr terminal detection independently", () => {
    const result = run(fixture(), [
      "-e",
      `import { colors } from ${JSON.stringify(colorsPath)};
       process.stdout.isTTY = true;
       const stdout = colors.success("ok");
       const pipedError = colors.error("error");
       process.stderr.isTTY = true;
       console.log(JSON.stringify({ stdout, pipedError, ttyError: colors.error("error") }));`,
    ]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.stdout).toContain("\u001b[32m");
    expect(output.pipedError).toBe("error");
    expect(output.ttyError).toContain("\u001b[31m");
  });

  test("honors NO_COLOR even on a terminal stream", () => {
    const result = run(
      fixture(),
      [
        "-e",
        `import { colors } from ${JSON.stringify(colorsPath)};
         process.stdout.isTTY = true;
         process.stderr.isTTY = true;
         console.log(JSON.stringify({ success: colors.success("ok"), error: colors.error("error") }));`,
      ],
      { NO_COLOR: "1" },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      success: "ok",
      error: "error",
    });
  });

  test("keeps default piped output plain", () => {
    const result = run(fixture(), [cliPath, "status"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("STATUS error (0 finding(s))\n");
    expect(result.stderr.toString()).not.toContain("\u001b[");
  });

  test("honors FORCE_COLOR=0 even on terminal streams", () => {
    const result = run(
      fixture(),
      [
        "-e",
        `import { colors } from ${JSON.stringify(colorsPath)};
         process.stdout.isTTY = true;
         process.stderr.isTTY = true;
         console.log(JSON.stringify({ success: colors.success("ok"), error: colors.error("error") }));`,
      ],
      { FORCE_COLOR: "0" },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      success: "ok",
      error: "error",
    });
  });

  test("lets an explicit FORCE_COLOR override NO_COLOR", () => {
    const result = run(fixture(), [cliPath, "status"], {
      FORCE_COLOR: "1",
      NO_COLOR: "1",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain("\u001b[31merror\u001b[39m");
    expect(result.stderr.toString()).toContain("\u001b[31m");
  });

  test("colors human status and operational errors when forced", () => {
    const result = run(fixture(), [cliPath, "status"], { FORCE_COLOR: "1" });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain("\u001b[31merror\u001b[39m");
    expect(result.stderr.toString()).toContain("\u001b[31m");
  });

  test("colors parser errors without coloring status error JSON", () => {
    const result = run(
      fixture(),
      [cliPath, "status", "--unsupported", "--json"],
      { FORCE_COLOR: "1" },
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      level: "error",
      findings: [],
    });
    expect(result.stdout.toString()).not.toContain("\u001b[");
    expect(result.stderr.toString()).toContain("\u001b[31m");
  });

  test("keeps operational error JSON plain even when color is forced", () => {
    const result = run(fixture(), [cliPath, "status", "--json"], {
      FORCE_COLOR: "1",
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      level: "error",
      findings: [],
    });
    expect(result.stdout.toString()).not.toContain("\u001b[");
  });

  test("keeps successful list JSON plain even when color is forced", () => {
    const cwd = fixture();
    writeManifest(join(cwd, "workforest.yaml"), {
      version: 1,
      repo: { name: "colors-fixture", root: cwd },
      worktrees: [{ path: cwd, branch: "main", isMain: true }],
      shared: {},
    });
    const result = run(cwd, [cliPath, "list", "--json"], { FORCE_COLOR: "1" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      { path: cwd, branch: "main", isMain: true, exists: true },
    ]);
    expect(result.stdout.toString()).not.toContain("\u001b[");
    expect(result.stderr.toString()).toBe("");
  });

  test("colors action labels while leaving paths plain", () => {
    const cwd = fixture();
    const initialized = Bun.spawnSync(["git", "init", "-b", "main"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initialized.exitCode).toBe(0);
    writeFileSync(join(cwd, "README.md"), "color fixture\n");
    const result = run(cwd, [cliPath, "init"], { FORCE_COLOR: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      `\u001b[32mCreated\u001b[39m ${join(cwd, "workforest.yaml")}`,
    );
    expect(result.stderr.toString()).toBe("");
  });

  for (const command of [undefined, "create", "sync"]) {
    test(`colors ${command ?? "top-level"} help without changing its layout`, () => {
      const cwd = fixture();
      const args = [cliPath, ...(command ? [command] : []), "--help"];
      const plain = run(cwd, args, { NO_COLOR: "1" });
      const colored = run(cwd, args, { FORCE_COLOR: "1" });
      expect(plain.exitCode).toBe(0);
      expect(colored.exitCode).toBe(0);
      const output = colored.stdout.toString();
      expect(output).toContain("\u001b[36mUsage:");
      expect(output).toContain("\u001b[2m");
      expect(stripVTControlCharacters(output)).toBe(plain.stdout.toString());
      expect(plain.stdout.toString()).not.toContain("\u001b[");
      expect(colored.stderr.toString()).toBe("");
    });
  }

  test("detects the stderr terminal when printing help after an error", () => {
    const result = run(fixture(), [
      "-e",
      `import { run } from ${JSON.stringify(cliPath)};
       process.stdout.isTTY = false;
       process.stderr.isTTY = true;
       run(["bun", "wf", "create"]);`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("\u001b[36mUsage:");
    expect(stripVTControlCharacters(result.stderr.toString())).toContain(
      "Usage: wf create [options] <folder> <branch-name>",
    );
  });

  test("colors worktree columns without changing table alignment or paths", () => {
    const cwd = fixture();
    const detached = join(cwd, "detached");
    mkdirSync(detached);
    writeManifest(join(cwd, "workforest.yaml"), {
      version: 1,
      repo: { name: "colors-fixture", root: cwd },
      worktrees: [
        { path: cwd, branch: "main", isMain: true },
        {
          path: join(cwd, "missing"),
          branch: "feature/missing",
          isMain: false,
        },
        { path: detached, branch: null, isMain: false },
      ],
      shared: {},
    });
    const plain = run(cwd, [cliPath, "list"], { NO_COLOR: "1" });
    const colored = run(cwd, [cliPath, "list"], { FORCE_COLOR: "1" });
    expect(plain.exitCode).toBe(0);
    expect(colored.exitCode).toBe(0);
    const output = colored.stdout.toString();
    expect(output).toContain("\u001b[36mPATH");
    expect(output).toContain("\u001b[36mfeature/missing");
    expect(output).toContain("\u001b[32mpresent");
    expect(output).toContain("\u001b[33mmissing");
    expect(output).toContain("\u001b[2mdetached");
    expect(output.split("\n")[1].startsWith(cwd)).toBe(true);
    expect(stripVTControlCharacters(output)).toBe(plain.stdout.toString());
    expect(plain.stdout.toString()).not.toContain("\u001b[");
  });
});
