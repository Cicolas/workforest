import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
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
import { join } from "node:path";

import { readManifest, writeManifest } from "../src/lib/config.ts";
import { discoverRepo } from "../src/lib/git.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function cli(cwd: string, ...args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workforest-partial-"));
  tempDirs.push(root);
  const main = join(root, "main");
  const feature = join(root, "feature");
  const manifestPath = join(root, "workforest.yaml");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Workforest Test");
  git(main, "config", "user.email", "workforest@example.com");
  writeFileSync(join(main, "README.md"), "initial\n");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "Initial commit");
  writeManifest(manifestPath, {
    version: 1,
    repo: { name: "fixture", root: main },
    worktrees: discoverRepo(main).activeWorktrees,
    shared: {},
  });
  return { root, main, feature, manifestPath };
}
function brokenCopy(main: string) {
  mkdirSync(join(main, "broken-copy"));
  symlinkSync("missing", join(main, "broken-copy", "child"));
}

test("failed create reports its surviving branch and worktree, then sync adopts them", () => {
  const { root, main, feature, manifestPath } = fixture();
  brokenCopy(main);
  const { manifest } = readManifest(root);
  manifest.shared = { "broken-copy": { target: "copy", copy: true } };
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  const result = cli(root, "create", feature, "feature/partial");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  const error = result.stderr.toString();
  expect(error).toContain("Partial completion");
  expect(error).toContain("Created branch feature/partial");
  expect(error).toContain(`Created worktree ${feature}`);
  expect(error).toContain(manifestPath);
  expect(error).toContain("wf sync");
  expect(existsSync(feature)).toBe(true);
  expect(discoverRepo(main).activeWorktrees).toHaveLength(2);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(existsSync(join(feature, "copy"))).toBe(false);
  expect(lstatSync(join(main, "broken-copy", "child")).isSymbolicLink()).toBe(
    true,
  );
  rmSync(join(main, "broken-copy", "child"));
  writeFileSync(join(main, "broken-copy", "child"), "corrected source\n");
  const recovered = cli(root, "sync");
  expect(recovered.exitCode).toBe(0);
  expect(discoverRepo(main).activeWorktrees).toHaveLength(2);
  expect(git(main, "branch", "--list", "feature/partial").trim()).toBe(
    "+ feature/partial",
  );
  expect(
    readManifest(root).manifest.worktrees.find(
      (entry) => entry.path === feature,
    )?.branch,
  ).toBe("feature/partial");
  expect(readFileSync(join(feature, "copy", "child"), "utf8")).toBe(
    "corrected source\n",
  );
});

test("sync reports an earlier sharing update when a later copy fails", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  brokenCopy(main);
  writeFileSync(join(main, "first-source"), "source preserved\n");
  writeFileSync(join(feature, "first-target"), "previous local contents\n");
  mkdirSync(join(feature, "copy"));
  writeFileSync(join(feature, "copy", "local"), "independent copy\n");
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  manifest.shared = {
    "first-source": "first-target",
    "broken-copy": { target: "copy", copy: true },
  };
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  const result = cli(root, "sync", "--refresh");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain(
    `Created shared link ${join(feature, "first-target")}`,
  );
  expect(result.stderr.toString()).toContain(
    `Previous target was preserved or restored`,
  );
  expect(result.stderr.toString()).toContain(manifestPath);
  expect(result.stderr.toString()).toContain("wf sync");
  expect(lstatSync(join(feature, "first-target")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(feature, "first-target"), "utf8")).toBe(
    "source preserved\n",
  );
  expect(readFileSync(join(main, "first-source"), "utf8")).toBe(
    "source preserved\n",
  );
  expect(readFileSync(join(feature, "copy", "local"), "utf8")).toBe(
    "independent copy\n",
  );
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
});

test("failed copy refresh with no-op pruning reports no completed changes", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  brokenCopy(main);
  mkdirSync(join(feature, "copy"));
  writeFileSync(join(feature, "copy", "local"), "independent copy\n");
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  manifest.shared = { "broken-copy": { target: "copy", copy: true } };
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  const beforeGit = git(main, "worktree", "list", "--porcelain");
  const result = cli(root, "sync", "--refresh");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No changes completed");
  expect(result.stderr.toString()).not.toContain("Partial completion");
  expect(git(main, "worktree", "list", "--porcelain")).toBe(beforeGit);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(readFileSync(join(feature, "copy", "local"), "utf8")).toBe(
    "independent copy\n",
  );
});

test("sync reports actual pruning before a later sharing failure", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  const missing = join(root, "missing");
  git(main, "worktree", "add", "-b", "feature/missing", missing);
  brokenCopy(main);
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  manifest.shared = { "broken-copy": { target: "copy", copy: true } };
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  rmSync(missing, { recursive: true });
  const result = cli(root, "sync");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain(
    `Pruned Git worktree registration ${missing}`,
  );
  expect(
    discoverRepo(main).activeWorktrees.some((entry) => entry.path === missing),
  ).toBe(false);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(
    readManifest(root).manifest.worktrees.some(
      (entry) => entry.path === missing,
    ),
  ).toBe(true);
  expect(git(main, "branch", "--list", "feature/missing")).toContain(
    "feature/missing",
  );
});

test("remove reports worktree removal and retained unmerged branch when manifest persistence also fails", () => {
  const { root, main, manifestPath } = fixture();
  // Keep the worktree parent writable while making manifest publication fail.
  const feature = join(main, "linked");
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  writeFileSync(join(feature, "unmerged"), "unmerged history\n");
  git(feature, "add", "unmerged");
  git(feature, "commit", "-m", "Unmerged work");
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  chmodSync(root, 0o555);
  const result = cli(root, "remove", feature, "--delete-branch");
  expect(result.exitCode).toBe(1);
  const error = result.stderr.toString();
  expect(error).toContain("Partial completion");
  expect(error).toContain(`Removed worktree ${feature}`);
  expect(error).toContain("branch deletion failed");
  expect(error).toContain("feature/partial");
  expect(error).toContain(manifestPath);
  expect(error).not.toContain("updated the manifest");
  expect(error).toContain("wf sync");
  expect(existsSync(feature)).toBe(false);
  expect(git(main, "branch", "--list", "feature/partial")).toContain(
    "feature/partial",
  );
  expect(discoverRepo(main).activeWorktrees).toHaveLength(1);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(readManifest(root).manifest.worktrees).toHaveLength(2);
  chmodSync(root, 0o700);
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(readManifest(root).manifest.worktrees).toHaveLength(1);
});

function faultyCli(
  root: string,
  preload: string,
  env: Record<string, string>,
  ...args: string[]
) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "fixtures", preload),
      join(import.meta.dir, "../src/cli.ts"),
      ...args,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    },
  );
}

test("manifest cleanup failure reports completed replacement and leaves new inventory readable", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  const result = faultyCli(
    root,
    "operation-failures.ts",
    {
      WORKFOREST_TEST_OPERATION_TARGET: manifestPath,
      WORKFOREST_TEST_OPERATION_FAULT: "manifest-cleanup",
    },
    "sync",
  );
  expect(result.exitCode).toBe(1);
  const error = result.stderr.toString();
  expect(error).toContain("Partial completion");
  expect(error).toContain(`Replaced manifest ${manifestPath}`);
  expect(error).toContain("Manifest replacement completed");
  expect(error).not.toContain("Manifest was not updated");
  expect(readManifest(root).manifest.worktrees).toHaveLength(2);
  const artifacts = error.match(/recovery artifacts at (.*?): Injected/)?.[1];
  expect(artifacts).toBeDefined();
  expect(lstatSync(artifacts!).isDirectory()).toBe(true);
});

test("copy cleanup failure records the installed copy before reporting retained artifacts", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  writeFileSync(join(main, "data"), "new source\n");
  writeFileSync(join(feature, "copy"), "independent copy\n");
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  manifest.shared = { data: { target: "copy", copy: true } };
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  const target = join(feature, "copy");
  const result = faultyCli(
    root,
    "copy-failures.ts",
    {
      WORKFOREST_TEST_COPY_TARGET: target,
      WORKFOREST_TEST_COPY_FAULT: "cleanup-success",
    },
    "sync",
    "--refresh",
  );
  expect(result.exitCode).toBe(1);
  const error = result.stderr.toString();
  expect(error).toContain("Partial completion");
  expect(error).toContain(`Replaced shared copy ${target}`);
  expect(error).toContain(`Copy replaced at ${target}`);
  const artifacts = error.match(
    /recovery artifacts remain at (.*?)\. Inspect/,
  )?.[1];
  expect(artifacts).toBeDefined();
  expect(lstatSync(artifacts!).isDirectory()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("new source\n");
  expect(readFileSync(join(main, "data"), "utf8")).toBe("new source\n");
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
});

test("link creation failure reports an already removed conflicting target", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  writeFileSync(join(main, "data"), "source preserved\n");
  const target = join(feature, "target");
  writeFileSync(target, "previous local contents\n");
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  manifest.shared = { data: "target" };
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  const result = faultyCli(
    root,
    "operation-failures.ts",
    {
      WORKFOREST_TEST_OPERATION_TARGET: target,
      WORKFOREST_TEST_OPERATION_FAULT: "link-create",
    },
    "sync",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain(
    `Removed previous shared target ${target}`,
  );
  expect(result.stderr.toString()).not.toContain(
    `Created shared link ${target}`,
  );
  expect(result.stderr.toString()).toContain("wf sync");
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source preserved\n");
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(readFileSync(target, "utf8")).toBe("source preserved\n");
});

test("Git checkout-hook failure reports the branch and directory already created", () => {
  const { root, main, feature, manifestPath } = fixture();
  const hook = join(main, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const before = readFileSync(manifestPath, "utf8");
  const result = cli(root, "create", feature, "feature/partial");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain("Created branch feature/partial");
  expect(result.stderr.toString()).toContain(
    `Created worktree directory ${feature}`,
  );
  expect(existsSync(feature)).toBe(true);
  expect(discoverRepo(main).activeWorktrees).toHaveLength(2);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(readManifest(root).manifest.worktrees).toHaveLength(2);
});

test("create reports Git changes when publishing the manifest fails", () => {
  const { root, main, manifestPath } = fixture();
  const feature = join(main, "linked");
  const before = readFileSync(manifestPath, "utf8");
  chmodSync(root, 0o555);
  const result = cli(root, "create", feature, "feature/partial");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain(`Created worktree ${feature}`);
  expect(result.stderr.toString()).toContain("Manifest was not updated");
  expect(result.stderr.toString()).toContain(manifestPath);
  expect(discoverRepo(main).activeWorktrees).toHaveLength(2);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  chmodSync(root, 0o700);
  expect(cli(root, "sync").exitCode).toBe(0);
  expect(readManifest(root).manifest.worktrees).toHaveLength(2);
});

test("link failure reports created parents even when no prior target existed", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  writeFileSync(join(main, "data"), "source preserved\n");
  const target = join(feature, "nested", "target");
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  manifest.shared = { data: "nested/target" };
  writeManifest(manifestPath, manifest);
  const result = faultyCli(
    root,
    "operation-failures.ts",
    {
      WORKFOREST_TEST_OPERATION_TARGET: target,
      WORKFOREST_TEST_OPERATION_FAULT: "link-create",
    },
    "sync",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Partial completion");
  expect(result.stderr.toString()).toContain(
    `Created sharing directory ${join(feature, "nested")}`,
  );
  expect(lstatSync(join(feature, "nested")).isDirectory()).toBe(true);
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source preserved\n");
});

test("failed Git removal warns about partially removed contents without claiming no changes", () => {
  const { root, main, feature, manifestPath } = fixture();
  git(main, "worktree", "add", "-b", "feature/partial", feature);
  const { manifest } = readManifest(root);
  manifest.worktrees = discoverRepo(main).activeWorktrees;
  writeManifest(manifestPath, manifest);
  const before = readFileSync(manifestPath, "utf8");
  chmodSync(root, 0o555);
  const result = cli(root, "remove", feature);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Completion uncertain");
  expect(result.stderr.toString()).not.toContain("No changes completed");
  expect(result.stderr.toString()).toContain(feature);
  expect(result.stderr.toString()).toContain("inspect remaining contents");
  expect(existsSync(feature)).toBe(true);
  expect(existsSync(join(feature, "README.md"))).toBe(false);
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(git(main, "branch", "--list", "feature/partial")).toContain(
    "feature/partial",
  );
});
