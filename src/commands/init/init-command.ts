import type { Command } from "commander";

import { reportAndExit } from "../../lib/errors.ts";
import { initWorkforest } from "./init.ts";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Create a workforest.yaml manifest for the current repository.",
    )
    .argument("[main-folder]", "folder containing the main git worktree")
    .action((mainFolder?: string) => {
      try {
        const result = initWorkforest(process.cwd(), mainFolder);
        const discoveryLabel = result.gitDiscovered
          ? "git metadata discovered"
          : "scaffolded without git metadata";
        console.log(`Created ${result.manifestPath} (${discoveryLabel})`);
      } catch (error) {
        reportAndExit(error);
      }
    });
}
