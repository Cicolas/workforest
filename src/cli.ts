import { initWorkforest } from "./init.ts";
import { createWorktree } from "./create.ts";

function printUsage(): void {
  console.error(
    "Usage: wf init [main-folder] | wf create <folder> <branch-name>",
  );
}

function main(): void {
  const [, , command, ...args] = process.argv;

  try {
    if (!command) {
      printUsage();
      return;
    }

    if (command === "init") {
      const [mainFolder] = args;

      const result = initWorkforest(process.cwd(), mainFolder);
      const discoveryLabel = result.gitDiscovered
        ? "git metadata discovered"
        : "scaffolded without git metadata";
      console.log(`Created ${result.manifestPath} (${discoveryLabel})`);
      return;
    }

    if (command === "create") {
      const [folder, branchName] = args;

      if (!folder || !branchName) {
        printUsage();
        process.exit(1);
      }

      const result = createWorktree(process.cwd(), folder, branchName);
      console.log(
        `Created ${result.worktreePath} on ${result.branchName} (${result.sharedLinksCreated} shared link(s), manifest updated at ${result.manifestPath})`,
      );
      return;
    }

    printUsage();
    process.exit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(message);
    process.exit(1);
  }
}

main();
