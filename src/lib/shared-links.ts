import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import type { SharedPath } from "./manifest.ts";

export interface SharedLink {
  sourceRelative: string;
  sourcePath: string;
  targetPath: string;
  copy: boolean;
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

export function expandSharedLinks(
  repoRoot: string,
  worktreePath: string,
  shared: Record<string, SharedPath>,
  ignoredShared: Set<string>,
): SharedLink[] {
  const links: SharedLink[] = [];

  for (const [sourceRelative, entry] of Object.entries(shared)) {
    if (ignoredShared.has(sourceRelative)) {
      continue;
    }

    const targetRelative = typeof entry === "string" ? entry : entry.target;
    const copy = typeof entry !== "string" && entry.copy === true;

    if (!isGlobPattern(sourceRelative)) {
      links.push({
        sourceRelative,
        copy,
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
          copy,
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
  shared: Record<string, SharedPath>,
  ignoredShared: string[] = [],
  refresh: boolean | string = false,
): number {
  let created = 0;
  const ignoredSharedSet = new Set(ignoredShared);

  for (const {
    sourceRelative,
    sourcePath,
    targetPath,
    copy,
  } of expandSharedLinks(repoRoot, worktreePath, shared, ignoredSharedSet)) {
    if (!existsSync(sourcePath)) {
      continue;
    }

    if (copy) {
      const shouldRefresh =
        refresh === true ||
        (typeof refresh === "string" &&
          [
            sourceRelative,
            relative(repoRoot, sourcePath),
            relative(worktreePath, targetPath),
          ].includes(refresh));

      if (!shouldRefresh) {
        try {
          lstatSync(targetPath);
          continue;
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          ) {
            throw error;
          }
        }
      }

      if (
        sourcePath === targetPath ||
        sourcePath.startsWith(`${targetPath}${sep}`) ||
        targetPath.startsWith(`${sourcePath}${sep}`)
      ) {
        throw new Error(
          `Shared copy source and target must not overlap: ${sourcePath} -> ${targetPath}`,
        );
      }
      rmSync(targetPath, { recursive: true, force: true });
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, { recursive: true, dereference: true });
      created += 1;
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
