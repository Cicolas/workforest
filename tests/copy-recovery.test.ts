import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  const cwd = mkdtempSync(join(tmpdir(), "wf-copy-recovery-"));
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

test("failed directory copy preparation preserves the independent copy and source", () => {
  const { cwd, main, feature, manifestPath } = fixture({
    assets: { target: "public", copy: true },
  });
  mkdirSync(join(main, "assets"));
  writeFileSync(join(main, "assets", "good"), "source content");
  expect(run(cwd, "create", "feature", "feature").exitCode).toBe(0);
  writeFileSync(join(feature, "public", "good"), "independent edit");
  writeFileSync(join(feature, "public", "local"), "local only");
  symlinkSync("missing", join(main, "assets", "broken"));
  const before = snapshot(main, manifestPath);
  const result = run(cwd, "sync", "--refresh");
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(join(feature, "public", "good"), "utf8")).toBe(
    "independent edit",
  );
  expect(readFileSync(join(feature, "public", "local"), "utf8")).toBe(
    "local only",
  );
  expect(readFileSync(join(main, "assets", "good"), "utf8")).toBe(
    "source content",
  );
  expect(lstatSync(join(main, "assets", "broken")).isSymbolicLink()).toBe(true);
  expect(snapshot(main, manifestPath)).toEqual(before);
});

function runWithFault(cwd: string, target: string, fault: string) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      "--preload",
      resolve(import.meta.dir, "fixtures/copy-failures.ts"),
      cli,
      "sync",
      "--refresh",
    ],
    cwd,
    env: {
      ...process.env,
      WORKFOREST_TEST_COPY_TARGET: target,
      WORKFOREST_TEST_COPY_FAULT: fault,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("failed copy installation restores the previous independent file", () => {
  const { cwd, main, feature, manifestPath } = fixture({
    data: { target: "copied", copy: true },
  });
  expect(run(cwd, "create", "feature", "feature").exitCode).toBe(0);
  const target = join(feature, "copied");
  writeFileSync(target, "independent edit");
  const before = snapshot(main, manifestPath);
  const result = runWithFault(cwd, target, "install");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Injected copy rename failure");
  expect(readFileSync(target, "utf8")).toBe("independent edit");
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  expect(snapshot(main, manifestPath)).toEqual(before);
});

for (const fault of ["restore", "cleanup"]) {
  test(`failed ${fault} reports retained recovery locations with usable contents`, () => {
    const { cwd, main, feature, manifestPath } = fixture({
      data: { target: "copied", copy: true },
    });
    expect(run(cwd, "create", "feature", "feature").exitCode).toBe(0);
    const target = join(feature, "copied");
    writeFileSync(target, "independent edit");
    const before = snapshot(main, manifestPath);
    const result = runWithFault(cwd, target, fault);
    const diagnostic = result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    if (fault === "restore") {
      const previous = diagnostic.match(
        /Previous target retained at (.*?);/,
      )?.[1];
      const replacement = diagnostic.match(
        /prepared replacement retained at (.*?)\. Restore/,
      )?.[1];
      expect(previous).toBeDefined();
      expect(replacement).toBeDefined();
      expect(readFileSync(previous!, "utf8")).toBe("independent edit");
      expect(readFileSync(replacement!, "utf8")).toBe("source");
      expect(existsSync(target)).toBe(false);
      expect(diagnostic).toContain(`Restore the previous target to ${target}`);
    } else {
      const artifacts = diagnostic.match(
        /recovery artifacts retained at (.*?)\. Inspect/,
      )?.[1];
      expect(artifacts).toBeDefined();
      expect(lstatSync(artifacts!).isDirectory()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("independent edit");
      expect(diagnostic).toContain(`Previous target preserved at ${target}`);
    }
    expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
    expect(snapshot(main, manifestPath)).toEqual(before);
  });
}

test("failed directory installation restores all independent contents", () => {
  const { cwd, main, feature } = fixture({
    assets: { target: "public", copy: true },
  });
  mkdirSync(join(main, "assets"));
  writeFileSync(join(main, "assets", "good"), "source content");
  expect(run(cwd, "create", "feature", "feature").exitCode).toBe(0);
  const target = join(feature, "public");
  writeFileSync(join(target, "good"), "independent edit");
  writeFileSync(join(target, "local"), "local only");
  expect(runWithFault(cwd, target, "install").exitCode).not.toBe(0);
  expect(readFileSync(join(target, "good"), "utf8")).toBe("independent edit");
  expect(readFileSync(join(target, "local"), "utf8")).toBe("local only");
  expect(readFileSync(join(main, "assets", "good"), "utf8")).toBe(
    "source content",
  );
});

test("failed installation restores a destination symlink without changing its referent", () => {
  const { cwd, main, feature } = fixture({
    data: { target: "copied", copy: true },
  });
  expect(run(cwd, "create", "feature", "feature").exitCode).toBe(0);
  const target = join(feature, "copied");
  rmSync(target);
  symlinkSync(join(main, "data"), target);
  expect(runWithFault(cwd, target, "install").exitCode).not.toBe(0);
  expect(lstatSync(target).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("source");
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  expect(run(cwd, "sync", "--refresh").exitCode).toBe(0);
  expect(lstatSync(target).isFile()).toBe(true);
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
});

test("source symlinks copy their referents while ordinary sync, selective refresh and exclusions preserve other copies", () => {
  const { cwd, main, feature, manifestPath } = fixture({
    "source-alias": { target: "copied", copy: true },
    data: { target: "other", copy: true },
  });
  symlinkSync("data", join(main, "source-alias"));
  expect(run(cwd, "create", "feature", "feature").exitCode).toBe(0);
  expect(lstatSync(join(feature, "copied")).isFile()).toBe(true);
  writeFileSync(join(feature, "copied"), "independent edit");
  writeFileSync(join(feature, "other"), "other edit");
  writeFileSync(join(main, "data"), "new source");
  expect(run(cwd, "sync").exitCode).toBe(0);
  expect(readFileSync(join(feature, "copied"), "utf8")).toBe(
    "independent edit",
  );
  expect(run(cwd, "sync", "--refresh", "copied").exitCode).toBe(0);
  expect(readFileSync(join(feature, "copied"), "utf8")).toBe("new source");
  expect(readFileSync(join(feature, "other"), "utf8")).toBe("other edit");
  const loaded = readManifest(cwd);
  const entry = loaded.manifest.worktrees.find(
    (entry) => entry.path === feature,
  )!;
  entry.ignoreShared = ["source-alias"];
  writeManifest(manifestPath, loaded.manifest);
  writeFileSync(join(feature, "copied"), "excluded edit");
  expect(run(cwd, "sync", "--refresh").exitCode).toBe(0);
  expect(readFileSync(join(feature, "copied"), "utf8")).toBe("excluded edit");
  expect(readFileSync(join(feature, "other"), "utf8")).toBe("new source");
  expect(lstatSync(join(main, "source-alias")).isSymbolicLink()).toBe(true);
});

test("cleanup failure after successful replacement reports the completed copy and retained previous contents", () => {
  const { cwd, main, feature } = fixture({
    data: { target: "copied", copy: true },
  });
  expect(run(cwd, "create", "feature", "feature").exitCode).toBe(0);
  const target = join(feature, "copied");
  writeFileSync(target, "independent edit");
  writeFileSync(join(main, "data"), "updated source");
  const result = runWithFault(cwd, target, "cleanup-success");
  const diagnostic = result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(diagnostic).toContain(`Copy replaced at ${target}`);
  const artifacts = diagnostic.match(
    /recovery artifacts remain at (.*?)\. Inspect/,
  )?.[1];
  expect(artifacts).toBeDefined();
  expect(
    readdirSync(artifacts!).map((entry) =>
      readFileSync(join(artifacts!, entry), "utf8"),
    ),
  ).toEqual(["independent edit"]);
  expect(readFileSync(target, "utf8")).toBe("updated source");
  expect(readFileSync(join(main, "data"), "utf8")).toBe("updated source");
});
