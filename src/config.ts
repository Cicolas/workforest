import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { runGit } from "./git.ts";
import {
  serializeManifest,
  type WorkforestManifest,
  type WorktreeEntry,
} from "./manifest.ts";

interface ParseState {
  version?: number;
  repoName?: string;
  repoRoot?: string;
  worktrees: WorktreeEntry[];
  shared: Record<string, string>;
}

function parseYamlScalar(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === "null") {
    return null;
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed);
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseKeyValue(line: string): { key: string; value: string } {
  const separatorIndex = line.indexOf(":");

  if (separatorIndex === -1) {
    throw new Error(`Invalid config line: ${line}`);
  }

  return {
    key: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function parseWorktreeBlock(
  lines: string[],
  startIndex: number,
): { entry: WorktreeEntry; nextIndex: number } {
  const pathLine = lines[startIndex].trim();
  const pathPair = parseKeyValue(pathLine.slice(2).trim());
  let branch: string | null = null;
  let isMain = false;
  let nextIndex = startIndex + 1;

  if (pathPair.key !== "path") {
    throw new Error("Invalid worktree entry: expected path");
  }

  while (nextIndex < lines.length && lines[nextIndex].startsWith("    ")) {
    const pair = parseKeyValue(lines[nextIndex].trim());

    if (pair.key === "branch") {
      branch = parseYamlScalar(pair.value);
    } else if (pair.key === "isMain") {
      isMain = pair.value === "true";
    }

    nextIndex += 1;
  }

  return {
    entry: {
      path: parseYamlScalar(pathPair.value) ?? "",
      branch,
      isMain,
    },
    nextIndex,
  };
}

export function parseManifest(content: string): WorkforestManifest {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0 && !line.trim().startsWith("#"));

  const state: ParseState = {
    worktrees: [],
    shared: {},
  };

  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("version:")) {
      state.version = Number(line.slice("version:".length).trim());
      index += 1;
      continue;
    }

    if (line === "repo:") {
      index += 1;
      while (index < lines.length && lines[index].startsWith("  ")) {
        const pair = parseKeyValue(lines[index].trim());
        if (pair.key === "name") {
          state.repoName = parseYamlScalar(pair.value) ?? "";
        } else if (pair.key === "root") {
          state.repoRoot = parseYamlScalar(pair.value) ?? "";
        }
        index += 1;
      }
      continue;
    }

    if (line === "worktrees: []") {
      index += 1;
      continue;
    }

    if (line === "worktrees:") {
      index += 1;
      while (index < lines.length && lines[index].startsWith("  - ")) {
        const parsed = parseWorktreeBlock(lines, index);
        state.worktrees.push(parsed.entry);
        index = parsed.nextIndex;
      }
      continue;
    }

    if (line === "shared: {}") {
      index += 1;
      continue;
    }

    if (line === "shared:") {
      index += 1;
      while (index < lines.length && lines[index].startsWith("  ")) {
        const pair = parseKeyValue(lines[index].trim());
        state.shared[parseYamlScalar(pair.key) ?? ""] =
          parseYamlScalar(pair.value) ?? "";
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  if (state.version !== 1) {
    throw new Error("Unsupported or missing workforest manifest version.");
  }

  if (!state.repoName || !state.repoRoot) {
    throw new Error("Invalid workforest manifest: missing repo metadata.");
  }

  return {
    version: 1,
    repo: {
      name: state.repoName,
      root: state.repoRoot,
    },
    worktrees: state.worktrees,
    shared: state.shared,
  };
}

function findManifestForRepo(cwd: string): string | null {
  const repoRootResult = runGit(cwd, ["rev-parse", "--show-toplevel"]);

  if (!repoRootResult.success || !repoRootResult.stdout) {
    return null;
  }

  const repoRoot = resolve(repoRootResult.stdout);
  let currentDir = repoRoot;

  while (true) {
    const candidatePath = join(currentDir, "workforest.yaml");

    if (existsSync(candidatePath)) {
      const manifest = parseManifest(readFileSync(candidatePath, "utf8"));
      const matchesRepoRoot =
        resolve(manifest.repo.root) === repoRoot ||
        manifest.worktrees.some((entry) => resolve(entry.path) === repoRoot);

      if (matchesRepoRoot) {
        return candidatePath;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function readManifest(cwd: string): {
  manifestPath: string;
  manifest: WorkforestManifest;
} {
  const directManifestPath = join(cwd, "workforest.yaml");
  const manifestPath = existsSync(directManifestPath)
    ? directManifestPath
    : findManifestForRepo(cwd);

  if (!manifestPath) {
    throw new Error(`Missing workforest manifest: ${directManifestPath}`);
  }

  return {
    manifestPath,
    manifest: parseManifest(readFileSync(manifestPath, "utf8")),
  };
}

export function writeManifest(
  manifestPath: string,
  manifest: WorkforestManifest,
): void {
  writeFileSync(manifestPath, serializeManifest(manifest), "utf8");
}
