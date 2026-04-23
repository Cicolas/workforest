import { initWorkforest } from "./init.ts";

function printUsage(): void {
  console.error("Usage: wf init");
}

function main(): void {
  const [, , command] = process.argv;

  if (command !== "init") {
    printUsage();
    process.exit(command ? 1 : 0);
  }

  try {
    const result = initWorkforest(process.cwd());
    const discoveryLabel = result.gitDiscovered ? "git metadata discovered" : "scaffolded without git metadata";
    console.log(`Created ${result.manifestPath} (${discoveryLabel})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(message);
    process.exit(1);
  }
}

main();
