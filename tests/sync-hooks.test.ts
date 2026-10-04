import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest } from "../src/lib/config.ts";
import { discoverRepo } from "../src/lib/git.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function cli(root: string, ...args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wf-sync-hooks-"));
  roots.push(root);
  const main = join(root, "main");
  const feature = join(root, "feature");
  const manifestPath = join(root, "workforest.yaml");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.com");
  writeFileSync(join(main, "README.md"), "initial\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "Initial");
  git(main, "worktree", "add", "-b", "feature", feature);
  writeFileSync(join(main, "data"), "shared\n");
  writeManifest(manifestPath, {
    version: 1,
    repo: { name: "test", root: main },
    worktrees: discoverRepo(main).activeWorktrees,
    shared: { data: "data" },
  });
  return { root, main, feature, manifestPath };
}
function hook(root: string, event: string, body: string, name = "10-script") {
  const folder = join(root, ".workforest", event);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

test("sync wraps sharing with live worktree context and repeats hooks when sharing is unchanged", () => {
  const { root, main, feature } = fixture();
  git(feature, "switch", "-c", "live-branch");
  hook(
    root,
    "pre-sync",
    'printf "%s|%s|%s|%s|%s|%s\\n" "$WF_EVENT" "$PWD" "$WF_WORKTREE_PATH" "$WF_BRANCH" "$WF_REPO_ROOT" "$WF_MANIFEST_DIR" >> "$WF_MANIFEST_DIR/events"',
  );
  hook(
    root,
    "post-sync",
    'test -L data\ntest "$(cat data)" = shared\nprintf "%s|%s\\n" "$WF_EVENT" "$WF_BRANCH" >> "$WF_MANIFEST_DIR/events"',
  );
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(readFileSync(join(root, "events"), "utf8")).toBe(
    `${"pre-sync"}|${feature}|${feature}|live-branch|${main}|${root}\npost-sync|live-branch\npre-sync|${feature}|${feature}|live-branch|${main}|${root}\npost-sync|live-branch\n`,
  );
});

test("failed pre-sync preserves hook effects, stops later targets, and skip-hooks recovers inventory", () => {
  const { root, main, feature, manifestPath } = fixture();
  const later = join(root, "later");
  git(main, "worktree", "add", "-b", "later", later);
  const before = readFileSync(manifestPath, "utf8");
  hook(
    root,
    "pre-sync",
    'printf "%s\\n" "$WF_WORKTREE_PATH" >> "$WF_MANIFEST_DIR/events"\nprintf "effect\\n" > hook-effect\nexit 7',
  );
  hook(root, "post-sync", 'touch "$WF_MANIFEST_DIR/unexpected-post"');
  const failed = cli(root, "sync");
  expect(failed.exitCode).not.toBe(0);
  expect(readFileSync(join(root, "events"), "utf8")).toBe(`${feature}\n`);
  expect(readFileSync(join(feature, "hook-effect"), "utf8")).toBe("effect\n");
  expect(existsSync(join(feature, "data"))).toBe(false);
  expect(existsSync(join(later, "data"))).toBe(false);
  expect(existsSync(join(root, "unexpected-post"))).toBe(false);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  const error = failed.stderr.toString();
  expect(error).toContain("Completion uncertain");
  expect(error).toContain("pre-sync");
  expect(error).toContain("10-script");
  expect(error).toContain(feature);
  expect(error).toContain("wf hooks run");
  expect(error).toContain("wf sync --skip-hooks");
  expect(error).not.toContain("No changes completed");
  expect(cli(root, "sync", "--skip-hooks").exitCode).toBe(0);
  expect(readFileSync(join(later, "data"), "utf8")).toBe("shared\n");
  expect(readManifest(root).manifest.worktrees).toHaveLength(3);
  expect(readFileSync(join(root, "events"), "utf8")).toBe(`${feature}\n`);
});

test("post-sync sees sharing before final manifest persistence and failures preserve earlier target completion", () => {
  const { root, main, feature, manifestPath } = fixture();
  const later = join(root, "later");
  git(main, "worktree", "add", "-b", "later", later);
  const before = readFileSync(manifestPath, "utf8");
  writeFileSync(join(root, "manifest-before"), before);
  hook(
    root,
    "pre-sync",
    'printf "pre:%s\\n" "$WF_WORKTREE_PATH" >> "$WF_MANIFEST_DIR/events"',
  );
  hook(
    root,
    "post-sync",
    'test -L data\ncmp "$WF_MANIFEST_DIR/workforest.yaml" "$WF_MANIFEST_DIR/manifest-before"\nprintf "post:%s\\n" "$WF_WORKTREE_PATH" >> "$WF_MANIFEST_DIR/events"\nexit 8',
  );
  const result = cli(root, "sync");
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(join(root, "events"), "utf8")).toBe(
    `pre:${feature}\npost:${feature}\n`,
  );
  expect(readFileSync(join(feature, "data"), "utf8")).toBe("shared\n");
  expect(existsSync(join(later, "data"))).toBe(false);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain(
    `Completed pre-sync hooks for ${feature}`,
  );
  expect(result.stderr.toString()).toContain("Created shared link");
  expect(result.stderr.toString()).toContain(
    "post-sync hook effects may remain",
  );
});

test("sync skips main and missing worktrees and exposes an empty detached branch", () => {
  const { root, main, feature, manifestPath } = fixture();
  const missing = join(root, "missing");
  git(main, "worktree", "add", "-b", "missing", missing);
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  writeManifest(manifestPath, manifest);
  rmSync(missing, { recursive: true });
  git(feature, "switch", "--detach");
  hook(
    root,
    "pre-sync",
    'printf "%s|%s|%s\\n" "$WF_EVENT" "$WF_WORKTREE_PATH" "$WF_BRANCH" >> "$WF_MANIFEST_DIR/events"',
  );
  hook(
    root,
    "post-sync",
    'printf "%s|%s|%s\\n" "$WF_EVENT" "$WF_WORKTREE_PATH" "$WF_BRANCH" >> "$WF_MANIFEST_DIR/events"',
  );
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(readFileSync(join(root, "events"), "utf8")).toBe(
    `pre-sync|${feature}|\npost-sync|${feature}|\n`,
  );
  expect(readManifest(root).manifest.worktrees).toHaveLength(2);
  expect(
    discoverRepo(main).activeWorktrees.some((entry) => entry.path === missing),
  ).toBe(false);
});

test("sync validates every destination before hooks or stale registration pruning", () => {
  const { root, main, feature, manifestPath } = fixture();
  const later = join(root, "later");
  const missing = join(root, "missing");
  git(main, "worktree", "add", "-b", "later", later);
  git(main, "worktree", "add", "-b", "missing", missing);
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  manifest.shared = { data: "nested/data" };
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  symlinkSync(root, join(later, "nested"));
  rmSync(missing, { recursive: true });
  hook(root, "pre-sync", 'touch "$WF_MANIFEST_DIR/unexpected-hook"');
  const result = cli(root, "sync");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Shared target must be inside");
  expect(existsSync(join(root, "unexpected-hook"))).toBe(false);
  expect(existsSync(join(feature, "nested"))).toBe(false);
  expect(git(main, "worktree", "list", "--porcelain")).toContain(missing);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
});

test("failed sharing does not run post-sync or hooks for later worktrees", () => {
  const { root, main, feature, manifestPath } = fixture();
  const later = join(root, "later");
  git(main, "worktree", "add", "-b", "later", later);
  mkdirSync(join(main, "broken"));
  symlinkSync("missing", join(main, "broken", "child"));
  const { manifest } = readManifest(root);
  manifest.shared = { broken: { target: "copy", copy: true } };
  writeManifest(manifestPath, manifest);
  hook(
    root,
    "pre-sync",
    'printf "pre:%s\\n" "$WF_WORKTREE_PATH" >> "$WF_MANIFEST_DIR/events"',
  );
  hook(
    root,
    "post-sync",
    'printf "post:%s\\n" "$WF_WORKTREE_PATH" >> "$WF_MANIFEST_DIR/events"',
  );
  const result = cli(root, "sync");
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(join(root, "events"), "utf8")).toBe(`pre:${feature}\n`);
  expect(result.stderr.toString()).toContain(
    `Completed pre-sync hooks for ${feature}`,
  );
  expect(result.stderr.toString()).not.toContain("post-sync hook effects");
  expect(existsSync(join(later, "copy"))).toBe(false);
});

test("sync completes both events for each target before starting the next target", () => {
  const { root, main, feature } = fixture();
  const later = join(root, "later");
  git(main, "worktree", "add", "-b", "later", later);
  hook(
    root,
    "pre-sync",
    'printf "pre:%s\\n" "$WF_WORKTREE_PATH" >> "$WF_MANIFEST_DIR/events"',
  );
  hook(
    root,
    "post-sync",
    'test -L data\nprintf "post:%s\\n" "$WF_WORKTREE_PATH" >> "$WF_MANIFEST_DIR/events"',
  );
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(readFileSync(join(root, "events"), "utf8")).toBe(
    `pre:${feature}\npost:${feature}\npre:${later}\npost:${later}\n`,
  );
  expect(readManifest(root).manifest.worktrees).toHaveLength(3);
});
