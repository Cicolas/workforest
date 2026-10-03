import { realpathSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";

import type { WorkforestManifest, WorktreeEntry } from "./manifest.ts";

export interface RepoDiscovery {
  isGitRepo: boolean;
  repoName: string;
  repoRoot: string;
  activeWorktrees: WorktreeEntry[];
}

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[]): CommandResult {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      success: result.exitCode === 0,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run git";
    return {
      success: false,
      stdout: "",
      stderr: message,
    };
  }
}

function parseRepoName(remoteUrl: string, repoRoot: string): string {
  if (!remoteUrl) {
    return basename(repoRoot);
  }

  const normalized = remoteUrl.replace(/\/+$/, "").replace(/\.git$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  const colonIndex = normalized.lastIndexOf(":");
  const separatorIndex = Math.max(slashIndex, colonIndex);

  if (separatorIndex === -1 || separatorIndex === normalized.length - 1) {
    return basename(repoRoot);
  }

  return normalized.slice(separatorIndex + 1);
}

function parseMainWorktreeRoot(cwd: string): string {
  const commonDirResult = runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);

  if (!commonDirResult.success || !commonDirResult.stdout) {
    throw new Error(
      "Unable to identify the main worktree: missing Git common directory.",
    );
  }

  const commonDir = realpathSync(commonDirResult.stdout);
  const mainRoot = dirname(commonDir);
  if (basename(commonDir) !== ".git") {
    throw new Error(
      "Unsupported repository layout: expected the main worktree Git directory at .git.",
    );
  }
  return mainRoot;
}

function parseBranchName(
  rawBranch: string | undefined,
  detached: boolean,
): string | null {
  if (detached || !rawBranch) {
    return null;
  }

  return rawBranch.replace(/^refs\/heads\//, "");
}

export function parseWorktreeList(
  raw: string,
  mainWorktreeRoot: string | null,
): WorktreeEntry[] {
  const blocks = raw
    .trim()
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const worktrees: WorktreeEntry[] = [];

  for (const block of blocks) {
    let worktreePath = "";
    let rawBranch: string | undefined;
    let detached = false;

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        rawBranch = line.slice("branch ".length);
      } else if (line === "detached") {
        detached = true;
      }
    }

    if (!worktreePath) {
      continue;
    }

    const resolvedPath = resolve(worktreePath);
    worktrees.push({
      path: resolvedPath,
      branch: parseBranchName(rawBranch, detached),
      isMain:
        mainWorktreeRoot !== null && resolvedPath === resolve(mainWorktreeRoot),
    });
  }

  return worktrees;
}

export function discoverRepo(gitCwd: string): RepoDiscovery {
  const resolvedGitCwd = resolve(gitCwd);
  const repoRootResult = runGit(resolvedGitCwd, [
    "rev-parse",
    "--show-toplevel",
  ]);

  if (!repoRootResult.success || !repoRootResult.stdout) {
    throw new Error(`Not a git repository: ${resolvedGitCwd}`);
  }

  const currentRoot = realpathSync(repoRootResult.stdout);
  const repoRoot = parseMainWorktreeRoot(resolvedGitCwd);
  const remoteUrlResult = runGit(resolvedGitCwd, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  const worktreeListResult = runGit(resolvedGitCwd, [
    "worktree",
    "list",
    "--porcelain",
  ]);

  if (!worktreeListResult.success) {
    throw new Error(
      worktreeListResult.stderr || "Failed to read git worktree information.",
    );
  }

  const activeWorktrees = parseWorktreeList(
    worktreeListResult.stdout,
    repoRoot,
  );
  const mainEntries = activeWorktrees.filter((entry) => entry.isMain);
  const mainRootResult = runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  const mainCommonDirResult = runGit(repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (
    mainEntries.length !== 1 ||
    activeWorktrees[0]?.path !== repoRoot ||
    !activeWorktrees.some((entry) => entry.path === currentRoot) ||
    !mainRootResult.success ||
    realpathSync(mainRootResult.stdout) !== repoRoot ||
    !mainCommonDirResult.success ||
    realpathSync(mainCommonDirResult.stdout) !== join(repoRoot, ".git")
  ) {
    throw new Error(
      "Unsupported or inconsistent repository layout: cannot verify the main worktree.",
    );
  }

  return {
    isGitRepo: true,
    repoName: parseRepoName(
      remoteUrlResult.success ? remoteUrlResult.stdout : "",
      repoRoot,
    ),
    repoRoot,
    activeWorktrees,
  };
}

export function validateSharedRepo(
  manifest: WorkforestManifest,
): RepoDiscovery {
  const repo = discoverRepo(manifest.repo.root);
  const mainEntries = manifest.worktrees.filter((entry) => entry.isMain);
  if (
    realpathSync(manifest.repo.root) !== repo.repoRoot ||
    mainEntries.length !== 1 ||
    resolve(mainEntries[0].path) !== repo.repoRoot
  ) {
    throw new Error(
      "Inconsistent manifest: repo.root and the main worktree marker must identify the actual main worktree. Reinitialize the manifest with the correct source root before sharing.",
    );
  }
  return repo;
}
