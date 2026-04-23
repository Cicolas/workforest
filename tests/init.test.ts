import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { initWorkforest } from "../src/init.ts";
import { parseWorktreeList } from "../src/git.ts";
import { serializeManifest } from "../src/manifest.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `Command failed: ${cmd.join(" ")}`);
  }

  return result.stdout.toString().trim();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("parseWorktreeList", () => {
  test("marks the main worktree from the git common dir root", () => {
    const raw = [
      "worktree /tmp/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /tmp/repo-feature",
      "HEAD def456",
      "branch refs/heads/feature/demo",
    ].join("\n");

    expect(parseWorktreeList(raw, "/tmp/repo")).toEqual([
      {
        path: resolve("/tmp/repo"),
        branch: "main",
        isMain: true,
      },
      {
        path: resolve("/tmp/repo-feature"),
        branch: "feature/demo",
        isMain: false,
      },
    ]);
  });
});

describe("initWorkforest", () => {
  test("creates a scaffold outside git", () => {
    const cwd = makeTempDir("workforest-no-git-");
    const result = initWorkforest(cwd);
    const manifestPath = join(cwd, "workforest.yaml");
    const content = readFileSync(manifestPath, "utf8");

    expect(result.gitDiscovered).toBe(false);
    expect(result.manifestPath).toBe(manifestPath);
    expect(content).toContain(`name: ${cwd.split("/").pop() ?? ""}`);
    expect(content).toContain(`root: ${cwd}`);
    expect(content).toContain(`- path: ${cwd}`);
    expect(content).toContain("branch: null");
    expect(content).toContain("isMain: true");
  });

  test("discovers git metadata for the current repository", () => {
    const cwd = makeTempDir("workforest-git-");

    run(["git", "init", "-b", "main"], cwd);
    run(["git", "config", "user.name", "Workforest Test"], cwd);
    run(["git", "config", "user.email", "workforest@example.com"], cwd);
    run(["git", "remote", "add", "origin", "git@github.com:test-owner/test-repo.git"], cwd);
    writeFileSync(join(cwd, "README.md"), "hello", "utf8");
    run(["git", "add", "README.md"], cwd);
    run(["git", "commit", "-m", "init"], cwd);

    const result = initWorkforest(cwd);
    const content = readFileSync(join(cwd, "workforest.yaml"), "utf8");

    expect(result.gitDiscovered).toBe(true);
    expect(content).toContain("name: test-repo");
    expect(content).toContain(`root: ${cwd}`);
    expect(content).toContain(`- path: ${cwd}`);
    expect(content).toContain("branch: main");
    expect(content).toContain("isMain: true");
    expect(content).toContain("shared: {}");
  });

  test("captures all active worktrees in a git repository", () => {
    const cwd = makeTempDir("workforest-multi-");
    const featureWorktree = `${cwd}-feature`;

    run(["git", "init", "-b", "main"], cwd);
    run(["git", "config", "user.name", "Workforest Test"], cwd);
    run(["git", "config", "user.email", "workforest@example.com"], cwd);
    writeFileSync(join(cwd, "README.md"), "hello", "utf8");
    run(["git", "add", "README.md"], cwd);
    run(["git", "commit", "-m", "init"], cwd);
    run(["git", "worktree", "add", "-b", "feature/demo", featureWorktree], cwd);

    tempDirs.push(featureWorktree);

    initWorkforest(cwd);
    const content = readFileSync(join(cwd, "workforest.yaml"), "utf8");

    expect(content).toContain(`- path: ${cwd}`);
    expect(content).toContain(`- path: ${featureWorktree}`);
    expect(content).toContain("branch: main");
    expect(content).toContain("branch: feature/demo");
  });

  test("refuses to overwrite an existing manifest", () => {
    const cwd = makeTempDir("workforest-existing-");
    writeFileSync(join(cwd, "workforest.yaml"), "version: 1\n", "utf8");

    expect(() => initWorkforest(cwd)).toThrow(/Refusing to overwrite/);
  });
});

describe("serializeManifest", () => {
  test("renders shared entries as plain yaml key value pairs", () => {
    const content = serializeManifest({
      version: 1,
      repo: {
        name: "demo",
        root: "/tmp/demo",
      },
      activeWorktrees: [
        {
          path: "/tmp/demo",
          branch: "main",
          isMain: true,
        },
      ],
      shared: {
        ".env": ".env",
        "node_modules": "node_modules",
      },
    });

    expect(content).toContain("shared:");
    expect(content).toContain("  .env: .env");
    expect(content).toContain("  node_modules: node_modules");
  });
});
