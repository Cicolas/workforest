import { resolve, basename, dirname } from "node:path";

import type { WorktreeEntry } from "./manifest.ts";

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

function parseMainWorktreeRoot(cwd: string): string | null {
  const commonDirResult = runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);

  if (!commonDirResult.success || !commonDirResult.stdout) {
    return null;
  }

  return dirname(commonDirResult.stdout);
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
        mainWorktreeRoot === null
          ? worktrees.length === 0
          : resolvedPath === resolve(mainWorktreeRoot),
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

  const repoRoot = resolve(repoRootResult.stdout);
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

  return {
    isGitRepo: true,
    repoName: parseRepoName(
      remoteUrlResult.success ? remoteUrlResult.stdout : "",
      repoRoot,
    ),
    repoRoot,
    activeWorktrees: parseWorktreeList(
      worktreeListResult.stdout,
      parseMainWorktreeRoot(resolvedGitCwd),
    ),
  };
}
