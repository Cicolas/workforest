import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { discoverRepo } from "./git.ts";
import { serializeManifest, type WorkforestManifest } from "./manifest.ts";

export interface InitResult {
  manifestPath: string;
  gitDiscovered: boolean;
}

function buildManifestFromRepo(repo: ReturnType<typeof discoverRepo>): WorkforestManifest {
  return {
    version: 1,
    repo: {
      name: repo.repoName,
      root: repo.repoRoot,
    },
    activeWorktrees: repo.activeWorktrees,
    shared: {},
  };
}

export function buildInitialManifest(cwd: string): WorkforestManifest {
  return buildManifestFromRepo(discoverRepo(cwd));
}

export function initWorkforest(cwd: string): InitResult {
  const manifestPath = join(cwd, "workforest.yaml");

  if (existsSync(manifestPath)) {
    throw new Error(`Refusing to overwrite existing manifest: ${manifestPath}`);
  }

  const repo = discoverRepo(cwd);
  const manifest = buildManifestFromRepo(repo);

  writeFileSync(manifestPath, serializeManifest(manifest), "utf8");

  return {
    manifestPath,
    gitDiscovered: repo.isGitRepo,
  };
}
