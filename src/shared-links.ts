import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

interface SharedLink {
  sourceRelative: string;
  sourcePath: string;
  targetPath: string;
}

function prepareSharedTarget(
  targetPath: string,
  expectedSourcePath: string,
): boolean {
  try {
    const stat = lstatSync(targetPath);

    if (!stat.isSymbolicLink()) {
      rmSync(targetPath, { recursive: true, force: true });
      return true;
    }

    const currentLink = readlinkSync(targetPath);
    const currentResolved = resolve(dirname(targetPath), currentLink);

    if (currentResolved !== expectedSourcePath) {
      rmSync(targetPath, { recursive: true, force: true });
      return true;
    }

    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }
}

function isGlobPattern(pathPattern: string): boolean {
  return pathPattern.includes("*");
}

function getGlobBase(pathPattern: string): string {
  const wildcardIndex = pathPattern.indexOf("*");
  if (wildcardIndex === -1) {
    return pathPattern;
  }

  return pathPattern.slice(0, wildcardIndex).replace(/\/+$/, "");
}

function collectRecursiveFiles(rootPath: string): string[] {
  const entries = readdirSync(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(rootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectRecursiveFiles(entryPath));
      continue;
    }

    files.push(entryPath);
  }

  return files;
}

function expandSharedLinks(
  repoRoot: string,
  worktreePath: string,
  shared: Record<string, string>,
  ignoredShared: Set<string>,
): SharedLink[] {
  const links: SharedLink[] = [];

  for (const [sourceRelative, targetRelative] of Object.entries(shared)) {
    if (ignoredShared.has(sourceRelative)) {
      continue;
    }

    if (!isGlobPattern(sourceRelative)) {
      links.push({
        sourceRelative,
        sourcePath: resolve(repoRoot, sourceRelative),
        targetPath: resolve(worktreePath, targetRelative),
      });
      continue;
    }

    if (!targetRelative.endsWith("/")) {
      throw new Error(
        `Shared glob targets must end with '/': ${targetRelative}`,
      );
    }

    const sourceBase = resolve(repoRoot, getGlobBase(sourceRelative));

    try {
      for (const sourcePath of collectRecursiveFiles(sourceBase)) {
        const nestedRelative = relative(sourceBase, sourcePath);
        links.push({
          sourceRelative,
          sourcePath,
          targetPath: resolve(worktreePath, targetRelative, nestedRelative),
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }

      throw error;
    }
  }

  return links;
}

export function applySharedLinks(
  repoRoot: string,
  worktreePath: string,
  shared: Record<string, string>,
  ignoredShared: string[] = [],
): number {
  let created = 0;
  const ignoredSharedSet = new Set(ignoredShared);

  for (const { sourcePath, targetPath } of expandSharedLinks(
    repoRoot,
    worktreePath,
    shared,
    ignoredSharedSet,
  )) {
    if (!existsSync(sourcePath)) {
      continue;
    }

    if (!prepareSharedTarget(targetPath, sourcePath)) {
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    symlinkSync(relative(dirname(targetPath), sourcePath), targetPath);
    created += 1;
  }

  return created;
}
