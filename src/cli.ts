import { initWorkforest } from "./init.ts";
import { createWorktree } from "./create.ts";
import { syncWorktrees } from "./sync.ts";

function printUsage(): void {
  console.error(
    "Usage: wf init [main-folder] | wf create <folder> <branch-name> | wf sync",
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

    if (command === "sync") {
      const result = syncWorktrees(process.cwd());
      console.log(
        `Synced ${result.worktrees.length} worktree(s) (${result.createdWorktrees.length} created, ${result.removedWorktrees.length} removed, ${result.sharedLinksCreated} shared link(s) updated)`,
      );

      for (const worktree of result.worktrees) {
        const branchLabel = worktree.branch ?? "detached";
        const mainLabel = worktree.isMain ? " main" : "";
        console.log(`- ${worktree.path} [${branchLabel}]${mainLabel}`);
      }
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
