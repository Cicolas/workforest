export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
  ignoreShared?: string[];
}

export interface WorkforestManifest {
  version: 1;
  repo: {
    name: string;
    root: string;
  };
  worktrees: WorktreeEntry[];
  shared: Record<string, string>;
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function toYamlScalar(value: string): string {
  if (
    /^[A-Za-z0-9._/*-]+$/.test(value) &&
    !["null", "true", "false"].includes(value)
  ) {
    return value;
  }

  return quoteYamlString(value);
}

export function serializeManifest(manifest: WorkforestManifest): string {
  const lines: string[] = [
    "version: 1",
    "repo:",
    `  name: ${toYamlScalar(manifest.repo.name)}`,
    `  root: ${toYamlScalar(manifest.repo.root)}`,
  ];

  if (manifest.worktrees.length === 0) {
    lines.push("worktrees: []");
  } else {
    lines.push("worktrees:");

    for (const worktree of manifest.worktrees) {
      lines.push(`  - path: ${toYamlScalar(worktree.path)}`);
      lines.push(
        `    branch: ${worktree.branch === null ? "null" : toYamlScalar(worktree.branch)}`,
      );
      lines.push(`    isMain: ${worktree.isMain ? "true" : "false"}`);

      if (worktree.ignoreShared && worktree.ignoreShared.length > 0) {
        lines.push("    ignoreShared:");
        for (const sourcePath of worktree.ignoreShared) {
          lines.push(`      - ${toYamlScalar(sourcePath)}`);
        }
      }
    }
  }

  if (Object.keys(manifest.shared).length === 0) {
    lines.push("shared: {}");
  } else {
    lines.push("shared:");
    lines.push(
      "  # source path in the main worktree: target path to create in other worktrees",
    );
    for (const [sourcePath, targetPath] of Object.entries(manifest.shared)) {
      lines.push(`  ${toYamlScalar(sourcePath)}: ${toYamlScalar(targetPath)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
