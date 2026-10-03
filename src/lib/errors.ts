import { colors } from "./colors.ts";

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function reportAndExit(error: unknown): never {
  console.error(colors.error(formatError(error)));
  process.exit(1);
}

/** Records completed mutations so failures describe the state users must recover. */
export class OperationProgress {
  private readonly actions: string[] = [];
  private readonly incomplete: string[] = [];
  private manifestReplaced = false;

  record = (action: string, completed = true): void => {
    (completed ? this.actions : this.incomplete).push(action);
  };

  recordManifest = (action: string, manifestReplaced: boolean): void => {
    this.manifestReplaced ||= manifestReplaced;
    this.record(action);
  };

  failure(error: unknown, manifestPath: string, recovery: string): Error {
    const completion =
      this.actions.length > 0
        ? `Partial completion. Completed: ${this.actions.join("; ")}.`
        : this.incomplete.length > 0
          ? "Completion uncertain."
          : "No changes completed.";
    return new Error(
      `${completion} ${this.incomplete.length > 0 ? `Incomplete actions: ${this.incomplete.join("; ")}. ` : ""}${formatError(error)} Manifest: ${manifestPath}. ${this.manifestReplaced ? "Manifest replacement completed." : "Manifest was not updated; its inventory or sharing may still differ from Git and disk."} ${recovery}`,
      { cause: error },
    );
  }
}
