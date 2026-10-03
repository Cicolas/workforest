import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

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
  const separatorIndex = pathPattern.lastIndexOf(sep, wildcardIndex);
  return pathPattern.slice(0, separatorIndex + 1);
}

function globMatcher(pattern: string): RegExp {
  const parts = pattern.split(sep);
  const expression = parts
    .map((part, index) => {
      if (part === "**") {
        return index === parts.length - 1 ? ".*" : "(?:[^/]+/)*";
      }
      const segment = part
        .split("*")
        .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      return segment + (index === parts.length - 1 ? "" : "/");
    })
    .join("");
  return new RegExp(`^${expression}$`);
}

function collectRecursiveFiles(
  rootPath: string,
  remainingDepth: number,
): string[] {
  const entries = readdirSync(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(rootPath, entry.name);

    if (entry.isDirectory()) {
      if (remainingDepth > 1) {
        files.push(...collectRecursiveFiles(entryPath, remainingDepth - 1));
      }
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

    if (
      /[?\[\]{}]|[@+!*]\(/.test(sourceRelative) ||
      (isGlobPattern(sourceRelative) &&
        (sourceRelative.includes("\\") ||
          sourceRelative
            .split(sep)
            .some((part) => part.includes("**") && part !== "**")))
    ) {
      throw new Error(
        `Unsupported shared glob pattern: ${sourceRelative}. Use '*' within a path segment or '**' as a complete segment.`,
      );
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

    const absolutePattern = resolve(repoRoot, sourceRelative);
    const sourceBase = getGlobBase(absolutePattern);
    const pattern = relative(sourceBase, absolutePattern);
    const matcher = globMatcher(pattern);
    const depth = pattern.split(sep).includes("**")
      ? Infinity
      : pattern.split(sep).length;

    try {
      for (const sourcePath of collectRecursiveFiles(sourceBase, depth)) {
        const nestedRelative = relative(sourceBase, sourcePath);
        if (!matcher.test(nestedRelative)) continue;
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

// Resolve existing ancestors without following the destination leaf: replacing a
// symlink must remove the link itself, never its referent.
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
    // A dangling symlink is an existing ancestor, not a missing directory.
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error(
          `Cannot validate path through a broken symlink: ${path}`,
        );
      }
    } catch (statError) {
      if (
        !(
          statError instanceof Error &&
          "code" in statError &&
          statError.code === "ENOENT"
        )
      ) {
        throw statError;
      }
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(canonicalPath(parent), basename(path));
  }
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

function validateDestination(worktreePath: string, targetPath: string): string {
  const root = resolve(worktreePath);
  const target = resolve(targetPath);
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = resolve(
    canonicalPath(dirname(target)),
    basename(target),
  );
  for (const [boundary, destination] of [
    [root, target],
    [canonicalRoot, canonicalTarget],
  ]) {
    const nested = relative(boundary, destination);
    if (
      !nested ||
      nested === ".." ||
      nested.startsWith(`..${sep}`) ||
      resolve(boundary, nested) !== destination
    ) {
      throw new Error(
        `Shared target must be inside the destination worktree, not its root: ${targetPath}`,
      );
    }
    if (nested.split(sep).includes(".git")) {
      throw new Error(
        `Shared target must not replace Git metadata: ${targetPath}`,
      );
    }
  }
  return canonicalTarget;
}

/** Validate every known operation before Git pruning/creation or file replacement. */
export function preflightSharedLinks(
  repoRoot: string,
  worktreePath: string,
  shared: Record<string, SharedPath>,
  ignoredShared: string[] = [],
): SharedLink[] {
  const ignored = new Set(ignoredShared);
  const links = expandSharedLinks(repoRoot, worktreePath, shared, ignored);
  const sources = links.map((link) => canonicalPath(link.sourcePath));
  const targets = links.map((link) =>
    resolve(canonicalPath(dirname(link.targetPath)), basename(link.targetPath)),
  );
  for (let i = 0; i < links.length; i++) {
    for (let j = 0; j < links.length; j++) {
      if (
        overlaps(targets[i], sources[j]) ||
        overlaps(links[i].targetPath, links[j].sourcePath)
      ) {
        throw new Error(
          `Shared source and target must not overlap: ${links[j].sourcePath} -> ${links[i].targetPath}`,
        );
      }
    }
    validateDestination(worktreePath, links[i].targetPath);
    for (let j = 0; j < i; j++) {
      if (overlaps(targets[i], targets[j])) {
        throw new Error(
          `Shared targets must not overlap: ${links[j].targetPath} -> ${links[i].targetPath}`,
        );
      }
    }
  }
  // Validate declared glob containers even when no sources currently match.
  for (const [source, entry] of Object.entries(shared)) {
    if (ignored.has(source)) continue;
    const target = typeof entry === "string" ? entry : entry.target;
    validateDestination(worktreePath, resolve(worktreePath, target));
  }
  return links;
}

function replaceCopy(sourcePath: string, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const staging = mkdtempSync(
    resolve(dirname(targetPath), ".workforest-copy-"),
  );
  const replacement = resolve(staging, "replacement");
  const previous = resolve(staging, "previous");
  let backedUp = false;
  let hasTarget = false;
  try {
    try {
      lstatSync(targetPath);
      hasTarget = true;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    cpSync(sourcePath, replacement, { recursive: true, dereference: true });
    if (hasTarget) {
      renameSync(targetPath, previous);
      backedUp = true;
    }
    renameSync(replacement, targetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (backedUp) {
      try {
        renameSync(previous, targetPath);
      } catch (restoreError) {
        throw new Error(
          `Copy replacement failed for ${targetPath}: ${message}. Previous target retained at ${previous}; prepared replacement retained at ${replacement}. Restore the previous target to ${targetPath} after inspecting these paths. Restoration failed: ${restoreError}`,
        );
      }
    }
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `Copy replacement failed for ${targetPath}: ${message}. ${hasTarget ? `Previous target preserved at ${targetPath}` : `No replacement installed at ${targetPath}`}; recovery artifacts retained at ${staging}. Inspect and remove those artifacts after recovery. Cleanup failed: ${cleanupError}`,
      );
    }
    throw new Error(
      `Copy replacement failed for ${targetPath}: ${message}. ${hasTarget ? "Previous target was preserved or restored" : "No replacement was installed"}; correct the source or filesystem problem and retry sync --refresh.`,
    );
  }
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `Copy replaced at ${targetPath}, but recovery artifacts remain at ${staging}. Inspect and remove those artifacts before retrying: ${error}`,
    );
  }
}

export function applySharedLinks(
  repoRoot: string,
  worktreePath: string,
  shared: Record<string, SharedPath>,
  ignoredShared: string[] = [],
  refresh: boolean | string = false,
): number {
  let created = 0;

  for (const {
    sourceRelative,
    sourcePath,
    targetPath,
    copy,
  } of preflightSharedLinks(repoRoot, worktreePath, shared, ignoredShared)) {
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
      replaceCopy(sourcePath, targetPath);
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
