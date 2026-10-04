import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
function cli(cwd: string, ...args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wf-lifecycle-hooks-"));
  roots.push(root);
  const main = join(root, "main");
  const target = join(root, "feature");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.com");
  writeFileSync(join(main, "README.md"), "initial\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "Initial");
  writeFileSync(join(main, "source"), "shared\n");
  writeFileSync(join(main, ".git", "info", "exclude"), "shared\n");
  writeManifest(join(root, "workforest.yaml"), {
    version: 1,
    repo: { name: "fixture", root: main },
    worktrees: discoverRepo(main).activeWorktrees,
    shared: { source: "shared" },
  });
  return { root, main, target };
}
function hook(root: string, event: string, body: string, name = "10-check") {
  const folder = join(root, ".workforest", event);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

test("create hooks receive context before creation and after sharing and manifest persistence", () => {
  const { root, main, target } = fixture();
  hook(
    root,
    "pre-create",
    '[ "$PWD" = "$WF_MANIFEST_DIR" ]; [ ! -e "$WF_WORKTREE_PATH" ]; printf "%s\\n" "$WF_EVENT" "$WF_WORKTREE_PATH" "$WF_BRANCH" "$WF_REPO_ROOT" "$WF_MANIFEST_DIR" > "$WF_MANIFEST_DIR/pre-context"',
  );
  hook(
    root,
    "post-create",
    '[ "$PWD" = "$WF_WORKTREE_PATH" ]; [ -L shared ]; grep -F "$WF_WORKTREE_PATH" "$WF_MANIFEST_DIR/workforest.yaml"; echo ready > "$WF_MANIFEST_DIR/post-ready"',
  );
  const result = cli(main, "create", target, "feature/hooks");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, "pre-context"), "utf8")).toBe(
    `pre-create\n${target}\nfeature/hooks\n${main}\n${root}\n`,
  );
  expect(readFileSync(join(root, "post-ready"), "utf8")).toBe("ready\n");
});

test("pre-create failure stops creation, keeps script effects, and skips later scripts", () => {
  const { root, main, target } = fixture();
  hook(root, "pre-create", 'echo started > "$WF_MANIFEST_DIR/effect"; exit 7');
  hook(root, "pre-create", 'echo later > "$WF_MANIFEST_DIR/later"', "20-later");
  const before = readFileSync(join(root, "workforest.yaml"), "utf8");
  const result = cli(root, "create", target, "feature/hooks");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Completion uncertain");
  expect(result.stderr.toString()).toContain("pre-create '10-check'");
  expect(result.stderr.toString()).toContain("wf hooks run");
  expect(existsSync(target)).toBe(false);
  expect(git(main, "branch", "--list", "feature/hooks")).toBe("");
  expect(existsSync(join(root, "effect"))).toBe(true);
  expect(existsSync(join(root, "later"))).toBe(false);
  expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(before);
});

test("post-create failure preserves ready worktree and supports manual retry", () => {
  const { root, target } = fixture();
  hook(root, "post-create", "exit 8");
  const result = cli(root, "create", target, "feature/hooks");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain("Manifest replacement completed");
  expect(result.stderr.toString()).toContain("wf sync --skip-hooks");
  expect(existsSync(join(target, "shared"))).toBe(true);
  expect(
    readManifest(root).manifest.worktrees.some(
      (entry) => entry.path === target,
    ),
  ).toBe(true);
  hook(root, "post-create", 'echo recovered > "$WF_MANIFEST_DIR/recovered"');
  expect(
    cli(root, "hooks", "run", "post-create", target, "--script", "10-check")
      .exitCode,
  ).toBe(0);
  expect(readFileSync(join(root, "recovered"), "utf8")).toBe("recovered\n");
});

test("skip-hooks bypasses create automation while Git post-checkout still executes", () => {
  const { root, main, target } = fixture();
  hook(root, "pre-create", "exit 9");
  const gitHook = join(main, ".git", "hooks", "post-checkout");
  writeFileSync(gitHook, "#!/bin/sh\nprintf git-hook > git-hook-ran\n");
  chmodSync(gitHook, 0o755);
  expect(
    cli(root, "create", target, "feature/hooks", "--skip-hooks").exitCode,
  ).toBe(0);
  expect(readFileSync(join(target, "git-hook-ran"), "utf8")).toBe("git-hook");
});

test("remove hooks surround removal and persisted inventory with operation context", () => {
  const { root, main, target } = fixture();
  expect(cli(root, "create", target, "feature/hooks").exitCode).toBe(0);
  hook(
    root,
    "pre-remove",
    '[ "$PWD" = "$WF_WORKTREE_PATH" ]; cat README.md > "$WF_MANIFEST_DIR/pre-read"',
  );
  hook(
    root,
    "post-remove",
    '[ "$PWD" = "$WF_MANIFEST_DIR" ]; [ ! -e "$WF_WORKTREE_PATH" ]; ! grep -F "$WF_WORKTREE_PATH" workforest.yaml; printf "%s\\n" "$WF_EVENT" "$WF_WORKTREE_PATH" "$WF_BRANCH" "$WF_REPO_ROOT" "$WF_MANIFEST_DIR" > post-context',
  );
  const result = cli(root, "remove", "feature/hooks", "--force");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, "pre-read"), "utf8")).toBe("initial\n");
  expect(readFileSync(join(root, "post-context"), "utf8")).toBe(
    `post-remove\n${target}\nfeature/hooks\n${main}\n${root}\n`,
  );
});

test("remove refuses existing dirt before cleanup and checks tracked changes introduced by cleanup", () => {
  const { root, target } = fixture();
  expect(cli(root, "create", target, "feature/hooks").exitCode).toBe(0);
  hook(
    root,
    "pre-remove",
    'echo cleanup > "$WF_MANIFEST_DIR/cleanup"; echo changed > README.md',
  );
  writeFileSync(join(target, "README.md"), "already dirty\n");
  expect(cli(root, "remove", target).exitCode).toBe(1);
  expect(existsSync(join(root, "cleanup"))).toBe(false);
  git(target, "restore", "README.md");
  const result = cli(root, "remove", target);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    "uncommitted changes after pre-remove",
  );
  expect(existsSync(join(root, "cleanup"))).toBe(true);
  expect(existsSync(target)).toBe(true);
  expect(readManifest(root).manifest.worktrees).toHaveLength(2);
  expect(cli(root, "remove", target, "--force").exitCode).toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("force still runs failing cleanup and skip-hooks enables removal recovery", () => {
  const { root, target } = fixture();
  expect(cli(root, "create", target, "feature/hooks").exitCode).toBe(0);
  hook(
    root,
    "pre-remove",
    'echo effect > "$WF_MANIFEST_DIR/remove-effect"; exit 6',
  );
  const result = cli(root, "remove", target, "--force");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("pre-remove '10-check'");
  expect(result.stderr.toString()).toContain("Completion uncertain");
  expect(existsSync(target)).toBe(true);
  expect(readManifest(root).manifest.worktrees).toHaveLength(2);
  expect(cli(root, "remove", target, "--skip-hooks").exitCode).toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("missing targets skip pre-remove and run post-remove after pruning and inventory persistence", () => {
  const { root, main, target } = fixture();
  expect(cli(root, "create", target, "feature/hooks").exitCode).toBe(0);
  hook(root, "pre-remove", "exit 9");
  hook(
    root,
    "post-remove",
    '[ ! -e "$WF_WORKTREE_PATH" ]; ! grep -F "$WF_WORKTREE_PATH" workforest.yaml; echo cleaned > missing-cleaned',
  );
  rmSync(target, { recursive: true });
  const result = cli(root, "remove", "feature/hooks");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain("Hook pre-remove");
  expect(readFileSync(join(root, "missing-cleaned"), "utf8")).toBe("cleaned\n");
  expect(discoverRepo(main).activeWorktrees).toHaveLength(1);
  expect(readManifest(root).manifest.worktrees).toHaveLength(1);
});

test("post-remove failure preserves completed removal and manual retry accepts the absent path", () => {
  const { root, target } = fixture();
  expect(cli(root, "create", target, "feature/hooks").exitCode).toBe(0);
  hook(root, "post-remove", "exit 5");
  const result = cli(root, "remove", target);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain(`Removed worktree ${target}`);
  expect(result.stderr.toString()).toContain("Manifest replacement completed");
  expect(existsSync(target)).toBe(false);
  expect(readManifest(root).manifest.worktrees).toHaveLength(1);
  hook(
    root,
    "post-remove",
    '[ "$WF_BRANCH" = "feature/hooks" ]; echo retried > remove-retried',
  );
  expect(
    cli(
      root,
      "hooks",
      "run",
      "post-remove",
      target,
      "--branch",
      "feature/hooks",
    ).exitCode,
  ).toBe(0);
  expect(existsSync(join(root, "remove-retried"))).toBe(true);
});

test("create sharing validation and main removal protection precede hooks", () => {
  const { root, main, target } = fixture();
  hook(root, "pre-create", 'echo invalid > "$WF_MANIFEST_DIR/invalid"');
  const loaded = readManifest(root);
  loaded.manifest.shared = { source: "../escape" };
  writeManifest(loaded.manifestPath, loaded.manifest);
  expect(cli(root, "create", target, "feature/hooks").exitCode).toBe(1);
  expect(existsSync(join(root, "invalid"))).toBe(false);
  hook(root, "pre-remove", 'echo invalid > "$WF_MANIFEST_DIR/invalid"');
  expect(cli(root, "remove", main, "--force").exitCode).toBe(1);
  expect(existsSync(join(root, "invalid"))).toBe(false);
});

test("detached removal receives an empty branch in both events", () => {
  const { root, target } = fixture();
  expect(cli(root, "create", target, "feature/hooks").exitCode).toBe(0);
  git(target, "checkout", "--detach");
  hook(
    root,
    "pre-remove",
    '[ -z "$WF_BRANCH" ]; echo detached > "$WF_MANIFEST_DIR/detached-pre"',
  );
  hook(
    root,
    "post-remove",
    '[ -z "$WF_BRANCH" ]; echo detached > detached-post',
  );
  expect(cli(root, "remove", target).exitCode).toBe(0);
  expect(existsSync(join(root, "detached-pre"))).toBe(true);
  expect(existsSync(join(root, "detached-post"))).toBe(true);
});

test("help exposes manual hook execution and create/remove skip flags", () => {
  const { root } = fixture();
  for (const command of ["create", "remove"]) {
    const result = cli(root, command, "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("--skip-hooks");
  }
  expect(cli(root, "hooks", "--help").stdout.toString()).toContain("list");
  const runHelp = cli(root, "hooks", "run", "--help").stdout.toString();
  expect(runHelp).toContain("<event> <target>");
  expect(runHelp).toContain("--script <filename>");
  expect(runHelp).toContain("--branch <name>");
});
