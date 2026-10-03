import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeManifest } from "../../lib/config.ts";
import { discoverRepo } from "../../lib/git.ts";
import type { WorkforestManifest } from "../../lib/manifest.ts";

export interface InitResult {
  manifestPath: string;
  gitDiscovered: boolean;
}

function buildManifestFromRepo(
  repo: ReturnType<typeof discoverRepo>,
): WorkforestManifest {
  return {
    version: 1,
    repo: {
      name: repo.repoName,
      root: repo.repoRoot,
    },
    worktrees: repo.activeWorktrees,
    shared: {
      ".env": ".env",
    },
  };
}

export function buildInitialManifest(
  cwd: string,
  mainFolder: string,
): WorkforestManifest {
  return buildManifestFromRepo(discoverRepo(resolve(cwd, mainFolder)));
}

export function initWorkforest(cwd: string, mainFolder?: string): InitResult {
  const manifestPath = join(cwd, "workforest.yaml");

  if (existsSync(manifestPath)) {
    throw new Error(`Refusing to overwrite existing manifest: ${manifestPath}`);
  }

  let repo;

  if (mainFolder) {
    const mainFolderPath = resolve(cwd, mainFolder);

    if (!existsSync(join(mainFolderPath, ".git"))) {
      throw new Error(
        `Main git folder does not contain .git: ${mainFolderPath}`,
      );
    }

    repo = discoverRepo(mainFolderPath);
  } else {
    repo = discoverRepo(cwd);
  }
  const manifest = buildManifestFromRepo(repo);

  writeManifest(manifestPath, manifest);

  return {
    manifestPath,
    gitDiscovered: repo.isGitRepo,
  };
}
