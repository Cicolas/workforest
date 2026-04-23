export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface WorkforestManifest {
  version: 1;
  repo: {
    name: string;
    root: string;
  };
  activeWorktrees: WorktreeEntry[];
  shared: Record<string, string>;
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function toYamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value) && !["null", "true", "false"].includes(value)) {
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

  if (manifest.activeWorktrees.length === 0) {
    lines.push("activeWorktrees: []");
  } else {
    lines.push("activeWorktrees:");

    for (const worktree of manifest.activeWorktrees) {
      lines.push(`  - path: ${toYamlScalar(worktree.path)}`);
      lines.push(
        `    branch: ${worktree.branch === null ? "null" : toYamlScalar(worktree.branch)}`,
      );
      lines.push(`    isMain: ${worktree.isMain ? "true" : "false"}`);
    }
  }

  if (Object.keys(manifest.shared).length === 0) {
    lines.push("shared: {}");
  } else {
    lines.push("shared:");

    for (const [sourcePath, targetPath] of Object.entries(manifest.shared)) {
      lines.push(`  ${toYamlScalar(sourcePath)}: ${toYamlScalar(targetPath)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
