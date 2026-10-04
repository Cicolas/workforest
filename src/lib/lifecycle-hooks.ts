import { discoverHooks, runHooks, type HookContext } from "./hooks.ts";

/** Runs an operation's hooks while recording effects for partial recovery. */
export async function runLifecycleHooks(
  context: HookContext,
  skipHooks: boolean | undefined,
  record: (action: string, completed?: boolean) => void,
): Promise<void> {
  if (
    skipHooks ||
    discoverHooks(context.manifestDir, context.event).length === 0
  )
    return;
  try {
    await runHooks(context);
  } catch (error) {
    record(
      `${context.event} hook effects may remain for ${context.worktreePath}`,
      false,
    );
    throw error;
  }
  record(
    `Completed ${context.event} hooks for ${context.worktreePath}; script effects remain`,
  );
}
