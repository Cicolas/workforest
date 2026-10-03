import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readManifest, writeManifest } from "../src/lib/config.ts";
import type { SharedPath } from "../src/lib/manifest.ts";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../src/cli.ts");
function run(cwd: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function fixture(shared: Record<string, SharedPath>) {
  const cwd = mkdtempSync(join(tmpdir(), "wf-sharing-safety-"));
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
  expect(run(cwd, "init", "main").exitCode).toBe(0);
  const loaded = readManifest(cwd);
  writeManifest(loaded.manifestPath, { ...loaded.manifest, shared });
  return { cwd, main, feature, manifestPath: loaded.manifestPath };
}
function snapshot(main: string, manifestPath: string) {
  return {
    branches: git(main, "branch", "--list"),
    registrations: git(main, "worktree", "list", "--porcelain"),
    manifest: readFileSync(manifestPath, "utf8"),
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("invalid glob destinations leave create and sync Git state and manifest unchanged", () => {
  const { cwd, main, feature, manifestPath } = fixture({
    "missing/**/*": "bad",
  });
  const missing = join(cwd, "missing");
  git(main, "worktree", "add", "-b", "stale", missing);
  rmSync(missing, { recursive: true });
  const before = snapshot(main, manifestPath);
  expect(run(cwd, "create", "feature", "feature").exitCode).not.toBe(0);
  expect(snapshot(main, manifestPath)).toEqual(before);
  expect(existsSync(feature)).toBe(false);
  expect(run(cwd, "sync").exitCode).not.toBe(0);
  expect(snapshot(main, manifestPath)).toEqual(before);
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
});

for (const target of [
  "../outside",
  ".",
  ".git",
  ".git/config",
  "nested/../.git",
  "nested/.git/config",
]) {
  test(`create rejects unsafe destination ${target} before creating a branch`, () => {
    const { cwd, main, feature, manifestPath } = fixture({ data: target });
    writeFileSync(join(cwd, "outside"), "independent");
    const before = snapshot(main, manifestPath);
    const result = run(cwd, "create", "feature", "feature");
    expect(result.exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(existsSync(feature)).toBe(false);
    expect(readFileSync(join(cwd, "outside"), "utf8")).toBe("independent");
    expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  });
}

for (const target of [
  "alias/data",
  "alias",
  "alias/child/data",
  "escape/data",
  "metadata/config",
]) {
  test(`sync rejects ancestor alias or source overlap at ${target} before touching earlier entries or pruning`, () => {
    const { cwd, main, feature, manifestPath } = fixture({
      data: "earlier",
      ".": { target, copy: true },
    });
    git(main, "worktree", "add", "-b", "feature", feature);
    const loaded = readManifest(cwd);
    const source = target === "alias" ? "../feature" : ".";
    writeManifest(manifestPath, {
      ...loaded.manifest,
      shared: { data: "earlier", [source]: { target, copy: true } },
    });
    symlinkSync(main, join(feature, "alias"));
    symlinkSync(cwd, join(feature, "escape"));
    symlinkSync(join(main, ".git"), join(feature, "metadata"));
    writeFileSync(join(feature, "earlier"), "independent earlier");
    const missing = join(cwd, "missing");
    git(main, "worktree", "add", "-b", "stale", missing);
    rmSync(missing, { recursive: true });
    const before = snapshot(main, manifestPath);
    expect(run(cwd, "sync", "--refresh").exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
    expect(readFileSync(join(feature, "earlier"), "utf8")).toBe(
      "independent earlier",
    );
  });
}

for (const target of ["collision", "collision/child"]) {
  test(`overlapping planned destinations ${target} are rejected before replacing the first entry`, () => {
    const { cwd, main, feature, manifestPath } = fixture({
      data: "collision",
      missing: target,
    });
    git(main, "worktree", "add", "-b", "feature", feature);
    writeFileSync(join(feature, "collision"), "local");
    const before = snapshot(main, manifestPath);
    expect(run(cwd, "sync").exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(readFileSync(join(feature, "collision"), "utf8")).toBe("local");
  });
}

test("safe destination symlink replacement and external sources preserve referents", () => {
  const { cwd, main, feature } = fixture({
    data: { target: "copied", copy: true },
    "../external": "external",
  });
  git(main, "worktree", "add", "-b", "feature", feature);
  writeFileSync(join(cwd, "external"), "outside source");
  symlinkSync(join(main, "data"), join(feature, "copied"));
  expect(run(cwd, "sync", "--refresh").exitCode).toBe(0);
  expect(lstatSync(join(feature, "copied")).isFile()).toBe(true);
  expect(readFileSync(join(feature, "copied"), "utf8")).toBe("source");
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  expect(readFileSync(join(cwd, "external"), "utf8")).toBe("outside source");
  expect(readFileSync(join(feature, "external"), "utf8")).toBe(
    "outside source",
  );
  expect(readManifest(cwd).manifest.worktrees).toHaveLength(2);
});

test("create inspects symlinked checkout ancestors before applying sharing", () => {
  const { cwd, main, feature, manifestPath } = fixture({
    data: "tracked-alias/data",
  });
  symlinkSync(main, join(main, "tracked-alias"));
  git(main, "add", "tracked-alias");
  git(main, "commit", "-m", "Track alias fixture");
  const beforeManifest = readFileSync(manifestPath, "utf8");
  expect(run(cwd, "create", "feature", "feature").exitCode).not.toBe(0);
  expect(existsSync(feature)).toBe(true);
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  expect(lstatSync(join(main, "data")).isFile()).toBe(true);
  expect(readFileSync(manifestPath, "utf8")).toBe(beforeManifest);
});

for (const [source, target] of [
  ["../feature/data", "data"],
  ["../feature", "nested"],
  ["../feature/nested/data", "nested"],
  ["source-alias", "data"],
]) {
  test(`sync rejects source identity or parent-child overlap ${source} -> ${target}`, () => {
    const { cwd, main, feature, manifestPath } = fixture({ [source]: target });
    git(main, "worktree", "add", "-b", "feature", feature);
    mkdirSync(join(feature, "nested"));
    writeFileSync(join(feature, "nested", "data"), "nested local");
    symlinkSync(join(feature, "data"), join(main, "source-alias"));
    const before = snapshot(main, manifestPath);
    expect(run(cwd, "sync").exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(readFileSync(join(feature, "data"), "utf8")).toBe("source");
    expect(readFileSync(join(feature, "nested", "data"), "utf8")).toBe(
      "nested local",
    );
    expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  });
}
