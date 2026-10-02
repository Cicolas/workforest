export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function reportAndExit(error: unknown): never {
  console.error(formatError(error));
  process.exit(1);
}
