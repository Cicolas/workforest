import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

import { readManifest, writeManifest } from "../src/config.ts";
import { createWorktree } from "../src/create.ts";
import { initWorkforest } from "../src/init.ts";
import { parseWorktreeList } from "../src/git.ts";
import { serializeManifest } from "../src/manifest.ts";
import { syncWorktrees } from "../src/sync.ts";

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
    throw new Error(
      result.stderr.toString().trim() || `Command failed: ${cmd.join(" ")}`,
    );
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
  test("falls back to git rev-parse when no main folder is given", () => {
    const cwd = makeTempDir("workforest-git-default-");

    run(["git", "init", "-b", "main"], cwd);
    run(["git", "config", "user.name", "Workforest Test"], cwd);
    run(["git", "config", "user.email", "workforest@example.com"], cwd);
    run(
      [
        "git",
        "remote",
        "add",
        "origin",
        "git@github.com:test-owner/default-repo.git",
      ],
      cwd,
    );
    writeFileSync(join(cwd, "README.md"), "hello", "utf8");
    run(["git", "add", "README.md"], cwd);
    run(["git", "commit", "-m", "init"], cwd);

    const result = initWorkforest(cwd);
    const content = readFileSync(join(cwd, "workforest.yaml"), "utf8");

    expect(result.gitDiscovered).toBe(true);
    expect(content).toContain("name: default-repo");
    expect(content).toContain(`root: ${cwd}`);
    expect(content).toContain(`- path: ${cwd}`);
    expect(content).toContain("branch: main");
    expect(content).toContain("shared:");
    expect(content).toContain(
      "  # source path in the main worktree: target path to create in other worktrees",
    );
    expect(content).toContain("  .env: .env");
  });

  test("requires the selected main folder to contain .git", () => {
    const cwd = makeTempDir("workforest-no-git-");

    expect(() => initWorkforest(cwd, "main")).toThrow(/does not contain \.git/);
  });

  test("discovers git metadata for the current repository", () => {
    const cwd = makeTempDir("workforest-git-");

    run(["git", "init", "-b", "main"], cwd);
    run(["git", "config", "user.name", "Workforest Test"], cwd);
    run(["git", "config", "user.email", "workforest@example.com"], cwd);
    run(
      [
        "git",
        "remote",
        "add",
        "origin",
        "git@github.com:test-owner/test-repo.git",
      ],
      cwd,
    );
    writeFileSync(join(cwd, "README.md"), "hello", "utf8");
    run(["git", "add", "README.md"], cwd);
    run(["git", "commit", "-m", "init"], cwd);

    const result = initWorkforest(cwd, ".");
    const content = readFileSync(join(cwd, "workforest.yaml"), "utf8");

    expect(result.gitDiscovered).toBe(true);
    expect(content).toContain("name: test-repo");
    expect(content).toContain(`root: ${cwd}`);
    expect(content).toContain(`- path: ${cwd}`);
    expect(content).toContain("branch: main");
    expect(content).toContain("isMain: true");
    expect(content).toContain("shared:");
    expect(content).toContain("  .env: .env");
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

    initWorkforest(cwd, ".");
    const content = readFileSync(join(cwd, "workforest.yaml"), "utf8");

    expect(content).toContain(`- path: ${cwd}`);
    expect(content).toContain(`- path: ${featureWorktree}`);
    expect(content).toContain("branch: main");
    expect(content).toContain("branch: feature/demo");
  });

  test("refuses to overwrite an existing manifest", () => {
    const cwd = makeTempDir("workforest-existing-");
    writeFileSync(join(cwd, "workforest.yaml"), "version: 1\n", "utf8");

    expect(() => initWorkforest(cwd, ".")).toThrow(/Refusing to overwrite/);
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
      worktrees: [
        {
          path: "/tmp/demo",
          branch: "main",
          isMain: true,
        },
      ],
      shared: {
        ".env": ".env",
        node_modules: "node_modules",
      },
    });

    expect(content).toContain("shared:");
    expect(content).toContain("  .env: .env");
    expect(content).toContain("  node_modules: node_modules");
  });

  test("keeps glob-style shared patterns readable", () => {
    const content = serializeManifest({
      version: 1,
      repo: {
        name: "demo",
        root: "/tmp/demo",
      },
      worktrees: [
        {
          path: "/tmp/demo",
          branch: "main",
          isMain: true,
        },
      ],
      shared: {
        "node_modules/**/*": "node_modules/",
      },
    });

    expect(content).toContain("  node_modules/**/*: node_modules/");
  });
});

describe("createWorktree", () => {
  test("creates a new worktree and applies shared symlinks", () => {
    const cwd = makeTempDir("workforest-create-");
    const mainDir = join(cwd, "main");
    const envPath = join(mainDir, ".env");
    const modulesPath = join(mainDir, "node_modules");

    mkdirSync(mainDir);
    run(["git", "init", "-b", "main"], mainDir);
    run(["git", "config", "user.name", "Workforest Test"], mainDir);
    run(["git", "config", "user.email", "workforest@example.com"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "hello", "utf8");
    writeFileSync(envPath, "TOKEN=abc\n", "utf8");
    mkdirSync(modulesPath);
    run(["git", "add", "README.md"], mainDir);
    run(["git", "commit", "-m", "init"], mainDir);

    initWorkforest(cwd, "main");
    const loaded = readManifest(cwd);
    writeManifest(loaded.manifestPath, {
      ...loaded.manifest,
      shared: {
        ".env": ".env",
        node_modules: "node_modules",
      },
    });

    const result = createWorktree(cwd, "feature-one", "feature/one");
    const createdEnvPath = join(result.worktreePath, ".env");
    const createdModulesPath = join(result.worktreePath, "node_modules");
    const updatedManifest = readManifest(cwd).manifest;

    tempDirs.push(result.worktreePath);

    expect(result.sharedLinksCreated).toBe(2);
    expect(lstatSync(createdEnvPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(createdModulesPath).isSymbolicLink()).toBe(true);
    expect(resolve(dirname(createdEnvPath), readlinkSync(createdEnvPath))).toBe(
      envPath,
    );
    expect(
      resolve(dirname(createdModulesPath), readlinkSync(createdModulesPath)),
    ).toBe(modulesPath);
    expect(
      updatedManifest.worktrees.some(
        (entry) => entry.path === result.worktreePath,
      ),
    ).toBe(true);
    expect(
      updatedManifest.worktrees.some(
        (entry) => entry.branch === "feature/one",
      ),
    ).toBe(true);
  });

  test("replaces existing files and directories in the new worktree with shared symlinks", () => {
    const cwd = makeTempDir("workforest-create-replace-");
    const mainDir = join(cwd, "main");
    const envPath = join(mainDir, ".env");
    const cacheDir = join(mainDir, "cache");

    mkdirSync(mainDir);
    run(["git", "init", "-b", "main"], mainDir);
    run(["git", "config", "user.name", "Workforest Test"], mainDir);
    run(["git", "config", "user.email", "workforest@example.com"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "hello", "utf8");
    writeFileSync(envPath, "TOKEN=abc\n", "utf8");
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, "seed.txt"), "seed\n", "utf8");
    run(["git", "add", "README.md", ".env", "cache"], mainDir);
    run(["git", "commit", "-m", "init"], mainDir);

    initWorkforest(cwd, "main");
    const loaded = readManifest(cwd);
    writeManifest(loaded.manifestPath, {
      ...loaded.manifest,
      shared: {
        ".env": ".env",
        cache: "cache",
      },
    });

    const result = createWorktree(cwd, "feature-two", "feature/two");
    const createdEnvPath = join(result.worktreePath, ".env");
    const createdCachePath = join(result.worktreePath, "cache");

    tempDirs.push(result.worktreePath);

    expect(lstatSync(createdEnvPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(createdCachePath).isSymbolicLink()).toBe(true);
    expect(resolve(dirname(createdEnvPath), readlinkSync(createdEnvPath))).toBe(
      envPath,
    );
    expect(
      resolve(dirname(createdCachePath), readlinkSync(createdCachePath)),
    ).toBe(cacheDir);
  });

  test("expands glob-style shared entries into nested symlinks", () => {
    const cwd = makeTempDir("workforest-create-glob-");
    const mainDir = join(cwd, "main");
    const packageDir = join(mainDir, "node_modules", "left-pad");
    const binDir = join(mainDir, "node_modules", ".bin");
    const packageFile = join(packageDir, "index.js");
    const binFile = join(binDir, "left-pad");

    mkdirSync(mainDir);
    run(["git", "init", "-b", "main"], mainDir);
    run(["git", "config", "user.name", "Workforest Test"], mainDir);
    run(["git", "config", "user.email", "workforest@example.com"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "hello", "utf8");
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(packageFile, "module.exports = 1;\n", "utf8");
    writeFileSync(binFile, "#!/usr/bin/env node\n", "utf8");
    run(["git", "add", "README.md"], mainDir);
    run(["git", "commit", "-m", "init"], mainDir);

    initWorkforest(cwd, "main");
    const loaded = readManifest(cwd);
    writeManifest(loaded.manifestPath, {
      ...loaded.manifest,
      shared: {
        "node_modules/**/*": "node_modules/",
      },
    });

    const result = createWorktree(cwd, "feature-glob", "feature/glob");
    const linkedPackageFile = join(
      result.worktreePath,
      "node_modules",
      "left-pad",
      "index.js",
    );
    const linkedBinFile = join(
      result.worktreePath,
      "node_modules",
      ".bin",
      "left-pad",
    );

    tempDirs.push(result.worktreePath);

    expect(result.sharedLinksCreated).toBe(2);
    expect(lstatSync(linkedPackageFile).isSymbolicLink()).toBe(true);
    expect(lstatSync(linkedBinFile).isSymbolicLink()).toBe(true);
    expect(
      resolve(dirname(linkedPackageFile), readlinkSync(linkedPackageFile)),
    ).toBe(packageFile);
    expect(resolve(dirname(linkedBinFile), readlinkSync(linkedBinFile))).toBe(
      binFile,
    );
  });

  test("skips shared links when the source path does not exist", () => {
    const cwd = makeTempDir("workforest-create-missing-source-");
    const mainDir = join(cwd, "main");
    const missingEnvPath = join(mainDir, ".env");

    mkdirSync(mainDir);
    run(["git", "init", "-b", "main"], mainDir);
    run(["git", "config", "user.name", "Workforest Test"], mainDir);
    run(["git", "config", "user.email", "workforest@example.com"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "hello", "utf8");
    run(["git", "add", "README.md"], mainDir);
    run(["git", "commit", "-m", "init"], mainDir);

    initWorkforest(cwd, "main");
    const loaded = readManifest(cwd);
    writeManifest(loaded.manifestPath, {
      ...loaded.manifest,
      shared: {
        ".env": ".env",
      },
    });

    const result = createWorktree(cwd, "feature-missing-source", "feature/missing-source");
    const createdEnvPath = join(result.worktreePath, ".env");

    tempDirs.push(result.worktreePath);

    expect(existsSync(missingEnvPath)).toBe(false);
    expect(result.sharedLinksCreated).toBe(0);
    expect(existsSync(createdEnvPath)).toBe(false);
  });
});

describe("syncWorktrees", () => {
  test("removes stale worktrees from the manifest after prune", () => {
    const cwd = makeTempDir("workforest-sync-prune-");
    const mainDir = join(cwd, "main");

    mkdirSync(mainDir);
    run(["git", "init", "-b", "main"], mainDir);
    run(["git", "config", "user.name", "Workforest Test"], mainDir);
    run(["git", "config", "user.email", "workforest@example.com"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "hello", "utf8");
    run(["git", "add", "README.md"], mainDir);
    run(["git", "commit", "-m", "init"], mainDir);

    initWorkforest(cwd, "main");
    const created = createWorktree(cwd, "feature-prune", "feature/prune");

    rmSync(created.worktreePath, { recursive: true, force: true });

    const result = syncWorktrees(cwd);
    const updatedManifest = readManifest(cwd).manifest;

    expect(result.removedWorktrees).toContain(created.worktreePath);
    expect(
      updatedManifest.worktrees.some(
        (entry) => entry.path === created.worktreePath,
      ),
    ).toBe(false);
  });

  test("adds existing git worktrees that are missing from the manifest", () => {
    const cwd = makeTempDir("workforest-sync-create-");
    const mainDir = join(cwd, "main");
    const envPath = join(mainDir, ".env");
    const extraPath = join(cwd, "feature-sync");

    mkdirSync(mainDir);
    run(["git", "init", "-b", "main"], mainDir);
    run(["git", "config", "user.name", "Workforest Test"], mainDir);
    run(["git", "config", "user.email", "workforest@example.com"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "hello", "utf8");
    writeFileSync(envPath, "TOKEN=abc\n", "utf8");
    run(["git", "add", "README.md"], mainDir);
    run(["git", "commit", "-m", "init"], mainDir);

    initWorkforest(cwd, "main");
    run(["git", "worktree", "add", "-b", "feature/sync", extraPath], mainDir);

    const loaded = readManifest(cwd);
    writeManifest(loaded.manifestPath, {
      ...loaded.manifest,
      worktrees: loaded.manifest.worktrees.filter((entry) => entry.isMain),
    });

    const result = syncWorktrees(cwd);
    const linkedEnvPath = join(extraPath, ".env");
    const updatedManifest = readManifest(cwd).manifest;

    tempDirs.push(extraPath);

    expect(result.createdWorktrees).toContain(extraPath);
    expect(lstatSync(linkedEnvPath).isSymbolicLink()).toBe(true);
    expect(resolve(dirname(linkedEnvPath), readlinkSync(linkedEnvPath))).toBe(
      envPath,
    );
    expect(
      updatedManifest.worktrees.some((entry) => entry.path === extraPath),
    ).toBe(true);
  });

  test("finds workforest.yaml from inside a worktree via git rev-parse", () => {
    const cwd = makeTempDir("workforest-sync-locate-");
    const mainDir = join(cwd, "main");
    const featurePath = join(cwd, "feature-locate");
    const envPath = join(mainDir, ".env");

    mkdirSync(mainDir);
    run(["git", "init", "-b", "main"], mainDir);
    run(["git", "config", "user.name", "Workforest Test"], mainDir);
    run(["git", "config", "user.email", "workforest@example.com"], mainDir);
    writeFileSync(join(mainDir, "README.md"), "hello", "utf8");
    writeFileSync(envPath, "TOKEN=abc\n", "utf8");
    run(["git", "add", "README.md"], mainDir);
    run(["git", "commit", "-m", "init"], mainDir);

    initWorkforest(cwd, "main");
    createWorktree(cwd, "feature-locate", "feature/locate");

    tempDirs.push(featurePath);

    const result = syncWorktrees(featurePath);

    expect(result.manifestPath).toBe(join(cwd, "workforest.yaml"));
    expect(lstatSync(join(featurePath, ".env")).isSymbolicLink()).toBe(true);
    expect(resolve(dirname(join(featurePath, ".env")), readlinkSync(join(featurePath, ".env")))).toBe(envPath);
  });
});
