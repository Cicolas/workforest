import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { readManifest } from "../../lib/config.ts";
import { discoverRepo } from "../../lib/git.ts";
import type { WorktreeEntry } from "../../lib/manifest.ts";
import { expandSharedLinks } from "../../lib/shared-links.ts";
import {
  resolveWorktreeTarget,
  TargetResolutionError,
} from "../../lib/target.ts";

export type StatusFindingCode =
  | "manifest_missing_git_worktree"
  | "git_missing_manifest_worktree"
  | "worktree_branch_mismatch"
  | "worktree_detached_mismatch"
  | "worktree_main_mismatch"
  | "worktree_path_missing"
  | "shared_copy_missing"
  | "shared_copy_wrong_type"
  | "shared_link_missing"
  | "shared_link_wrong_type"
  | "shared_link_wrong_target"
  | "target_ambiguous";

export interface StatusFinding {
  code: StatusFindingCode;
  path: string;
  branch: string | null;
  message: string;
}

export interface StatusResult {
  level: "ok" | "warning" | "error";
  findings: StatusFinding[];
}

function normalizedEntries(
  entries: WorktreeEntry[],
): Map<string, WorktreeEntry> {
  return new Map(
    entries.map((entry) => {
      const path = resolve(entry.path);
      return [path, { ...entry, path }];
    }),
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function statusWorktrees(cwd: string, target?: string): StatusResult {
  const { manifest } = readManifest(cwd);
  const discovery = discoverRepo(manifest.repo.root);
  const manifestEntries = normalizedEntries(manifest.worktrees);
  const gitEntries = normalizedEntries(discovery.activeWorktrees);
  const allEntries = new Map(manifestEntries);

  for (const [path, entry] of gitEntries) {
    if (!allEntries.has(path)) {
      allEntries.set(path, entry);
    }
  }

  const inspectedEntries =
    target === undefined
      ? [...allEntries.values()]
      : [resolveWorktreeTarget(cwd, target, [...allEntries.values()])];
  const findings: StatusFinding[] = [];

  for (const worktree of inspectedEntries) {
    const manifestEntry = manifestEntries.get(worktree.path);
    const addFinding = (
      code: StatusFindingCode,
      path: string,
      message: string,
    ) => {
      findings.push({ code, path, branch: worktree.branch, message });
    };

    if (!manifestEntry) {
      addFinding(
        "git_missing_manifest_worktree",
        worktree.path,
        "Git worktree is missing from the manifest.",
      );
      continue;
    }

    const gitEntry = gitEntries.get(worktree.path);
    if (gitEntry && manifestEntry.branch !== gitEntry.branch) {
      addFinding(
        manifestEntry.branch === null || gitEntry.branch === null
          ? "worktree_detached_mismatch"
          : "worktree_branch_mismatch",
        worktree.path,
        `Manifest branch is ${manifestEntry.branch ?? "detached"}; Git branch is ${gitEntry.branch ?? "detached"}.`,
      );
    }
    if (gitEntry && manifestEntry.isMain !== gitEntry.isMain) {
      addFinding(
        "worktree_main_mismatch",
        worktree.path,
        `Manifest main role is ${manifestEntry.isMain}; Git main role is ${gitEntry.isMain}.`,
      );
    }

    if (!gitEntries.has(worktree.path)) {
      addFinding(
        "manifest_missing_git_worktree",
        worktree.path,
        "Manifest entry is missing from the current Git worktree list.",
      );
    }

    if (!existsSync(worktree.path)) {
      addFinding(
        "worktree_path_missing",
        worktree.path,
        "Manifest entry path does not exist on disk.",
      );
      continue;
    }

    if (gitEntry?.isMain ?? manifestEntry.isMain) {
      continue;
    }

    const links = expandSharedLinks(
      manifest.repo.root,
      worktree.path,
      manifest.shared,
      new Set(manifestEntry.ignoreShared ?? []),
    ).sort((a, b) =>
      a.targetPath < b.targetPath ? -1 : a.targetPath > b.targetPath ? 1 : 0,
    );

    for (const { sourcePath, targetPath, copy } of links) {
      if (!existsSync(sourcePath)) {
        continue;
      }

      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(targetPath);
      } catch (error) {
        if (!isMissingPath(error)) {
          throw error;
        }
        addFinding(
          copy ? "shared_copy_missing" : "shared_link_missing",
          targetPath,
          copy
            ? `Shared copy is missing; expected a copy of ${sourcePath}.`
            : `Shared link is missing; expected a symlink to ${sourcePath}.`,
        );
        continue;
      }

      if (copy) {
        const sourceStat = statSync(sourcePath);
        if (
          stat.isSymbolicLink() ||
          stat.isDirectory() !== sourceStat.isDirectory() ||
          stat.isFile() !== sourceStat.isFile()
        ) {
          addFinding(
            "shared_copy_wrong_type",
            targetPath,
            `Expected a shared ${sourceStat.isDirectory() ? "directory" : "file"} copy of ${sourcePath}.`,
          );
        }
        continue;
      }

      if (!stat.isSymbolicLink()) {
        addFinding(
          "shared_link_wrong_type",
          targetPath,
          `Expected a shared symlink to ${sourcePath}.`,
        );
        continue;
      }

      const actualSourcePath = resolve(
        dirname(targetPath),
        readlinkSync(targetPath),
      );
      if (actualSourcePath !== sourcePath) {
        addFinding(
          "shared_link_wrong_target",
          targetPath,
          `Shared link points to ${actualSourcePath}; expected ${sourcePath}.`,
        );
      }
    }
  }

  return { level: findings.length > 0 ? "warning" : "ok", findings };
}

export function statusErrorResult(error: unknown): StatusResult {
  return {
    level: "error",
    findings:
      error instanceof TargetResolutionError &&
      error.code === "target_ambiguous"
        ? error.matches.map((worktree) => ({
            code: "target_ambiguous",
            path: resolve(worktree.path),
            branch: worktree.branch,
            message: error.message,
          }))
        : [],
  };
}
