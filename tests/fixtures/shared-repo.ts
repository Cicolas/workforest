import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readManifest, writeManifest } from "../../src/lib/config.ts";
import type { SharedPath } from "../../src/lib/manifest.ts";

export const cliPath = resolve(import.meta.dir, "../../src/cli.ts");

export function runCli(cwd: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliPath, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

export function snapshot(main: string, manifestPath: string) {
  return {
    branches: git(main, "branch", "--list"),
    registrations: git(main, "worktree", "list", "--porcelain"),
    manifest: readFileSync(manifestPath, "utf8"),
  };
}

/** Each test suite owns its roots and explicitly registers its own cleanup. */
export function createSharingFixtureSuite(prefix: string) {
  const roots: string[] = [];
  function fixture(shared: Record<string, SharedPath>) {
    const cwd = mkdtempSync(join(tmpdir(), prefix));
    roots.push(cwd);
    const main = join(cwd, "main");
    const feature = join(cwd, "feature");
    mkdirSync(main);
    git(main, "init", "-b", "main");
    git(main, "config", "user.name", "Test");
    git(main, "config", "user.email", "test@example.com");
    writeFileSync(join(main, "data"), "source");
    git(main, "add", ".");
    git(main, "commit", "-m", "Initial fixture");
    const initialized = runCli(cwd, "init", "main");
    if (initialized.exitCode !== 0)
      throw new Error(initialized.stderr.toString());
    const loaded = readManifest(cwd);
    writeManifest(loaded.manifestPath, { ...loaded.manifest, shared });
    return { cwd, main, feature, manifestPath: loaded.manifestPath };
  }
  function cleanup() {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  }
  return { fixture, cleanup };
}
