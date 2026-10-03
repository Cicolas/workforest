import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { runGit } from "./git.ts";
import {
  serializeManifest,
  type SharedPath,
  type SharedPathOptions,
  type WorkforestManifest,
  type WorktreeEntry,
} from "./manifest.ts";

interface ParseState {
  version?: number;
  repoName?: string;
  repoRoot?: string;
  worktrees: WorktreeEntry[];
  shared: Record<string, SharedPath>;
}

function parseYamlListItem(line: string): string {
  const trimmed = line.trim();

  if (!trimmed.startsWith("- ")) {
    throw new Error(`Invalid list item: ${line}`);
  }

  return trimmed.slice(2).trim();
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
  const ignoreShared: string[] = [];
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
    } else if (pair.key === "ignoreShared") {
      nextIndex += 1;

      while (
        nextIndex < lines.length &&
        lines[nextIndex].startsWith("      - ")
      ) {
        ignoreShared.push(
          parseYamlScalar(parseYamlListItem(lines[nextIndex])) ?? "",
        );
        nextIndex += 1;
      }

      continue;
    }

    nextIndex += 1;
  }

  return {
    entry: {
      path: parseYamlScalar(pathPair.value) ?? "",
      branch,
      isMain,
      ...(ignoreShared.length > 0 ? { ignoreShared } : {}),
    },
    nextIndex,
  };
}

function parseSharedBlock(
  lines: string[],
  startIndex: number,
): { source: string; entry: SharedPath; nextIndex: number } {
  const pair = parseKeyValue(lines[startIndex].trim());
  const source = parseYamlScalar(pair.key) ?? "";
  let nextIndex = startIndex + 1;

  if (pair.value !== "") {
    if (nextIndex < lines.length && lines[nextIndex].startsWith("    ")) {
      throw new Error(
        `Invalid shared entry for ${source}: use a target mapping to set options.`,
      );
    }
    return { source, entry: parseYamlScalar(pair.value) ?? "", nextIndex };
  }

  let target: string | null = null;
  let copy: boolean | undefined;
  while (nextIndex < lines.length && lines[nextIndex].startsWith("    ")) {
    const option = parseKeyValue(lines[nextIndex].trim());
    if (option.key === "target") {
      target = parseYamlScalar(option.value);
    } else if (option.key === "copy") {
      if (option.value !== "true" && option.value !== "false") {
        throw new Error(
          `Invalid shared copy option for ${source}: expected true or false.`,
        );
      }
      copy = option.value === "true";
    } else {
      throw new Error(`Unknown shared option for ${source}: ${option.key}`);
    }
    nextIndex += 1;
  }

  if (!target) {
    throw new Error(`Invalid shared entry for ${source}: missing target.`);
  }

  const entry: SharedPathOptions = {
    target,
    ...(copy !== undefined ? { copy } : {}),
  };
  return { source, entry, nextIndex };
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
        const parsed = parseSharedBlock(lines, index);
        state.shared[parsed.source] = parsed.entry;
        index = parsed.nextIndex;
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
  const document = serializeManifest(manifest);
  const stagingDirectory = mkdtempSync(
    join(dirname(manifestPath), ".workforest-manifest-"),
  );
  const stagingPath = join(stagingDirectory, "manifest");
  let persistenceError: unknown;
  try {
    const mode = existsSync(manifestPath)
      ? statSync(manifestPath).mode & 0o777
      : undefined;
    writeFileSync(stagingPath, document, { encoding: "utf8", mode });
    renameSync(stagingPath, manifestPath);
  } catch (error) {
    persistenceError = error;
  }

  try {
    rmSync(stagingDirectory, { recursive: true });
  } catch (cleanupError) {
    const detail =
      persistenceError instanceof Error
        ? persistenceError.message
        : "Manifest replacement completed";
    throw new Error(
      `${detail}. Could not clean up manifest recovery artifacts at ${stagingDirectory}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
  if (persistenceError) {
    throw persistenceError;
  }
}
