import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const hookEvents = [
  "pre-create",
  "post-create",
  "pre-remove",
  "post-remove",
  "pre-sync",
  "post-sync",
] as const;
export type HookEvent = (typeof hookEvents)[number];
export interface HookScript {
  name: string;
  path: string;
}
export interface HookContext {
  event: HookEvent;
  worktreePath: string;
  branch: string | null;
  repoRoot: string;
  manifestDir: string;
}
export function discoverHooks(
  manifestDir: string,
  event: HookEvent,
): HookScript[] {
  const folder = join(manifestDir, ".workforest", event);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.sort().flatMap((name) => {
    const path = join(folder, name);
    try {
      if (!statSync(path).isFile()) return [];
      accessSync(path, constants.X_OK);
    } catch (error) {
      if (
        ["EACCES", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return [];
      throw error;
    }
    return [{ name, path }];
  });
}

export async function runHooks(
  context: HookContext,
  script?: string,
): Promise<void> {
  context = {
    ...context,
    worktreePath: resolve(context.worktreePath),
    repoRoot: resolve(context.repoRoot),
    manifestDir: resolve(context.manifestDir),
  };
  const hooks = discoverHooks(context.manifestDir, context.event);
  const selected =
    script === undefined ? hooks : hooks.filter((hook) => hook.name === script);
  if (
    script !== undefined &&
    (!script ||
      script.includes("/") ||
      script.includes("\\") ||
      selected.length === 0)
  ) {
    throw new Error(
      `No executable hook '${script}' for ${context.event} targeting ${context.worktreePath}. Select a direct filename from wf hooks list.`,
    );
  }
  for (const hook of selected) {
    console.log(
      `Hook ${context.event}: ${hook.name} (${context.worktreePath})`,
    );
    const cwd =
      context.event === "pre-create" || context.event === "post-remove"
        ? context.manifestDir
        : context.worktreePath;
    await new Promise<void>((resolve, reject) => {
      const failure = (reason: string) =>
        new Error(
          `Hook ${context.event} '${hook.name}' failed for ${context.worktreePath}: ${reason}. Earlier hook effects may remain. Correct the script and rerun wf hooks run ${context.event} ${context.worktreePath} --script ${hook.name}.`,
        );
      let child;
      try {
        child = spawn(hook.path, [], {
          cwd,
          stdio: "inherit",
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            WF_EVENT: context.event,
            WF_WORKTREE_PATH: context.worktreePath,
            WF_BRANCH: context.branch ?? "",
            WF_REPO_ROOT: context.repoRoot,
            WF_MANIFEST_DIR: context.manifestDir,
          },
        });
      } catch (error) {
        reject(
          failure(
            (error as NodeJS.ErrnoException).code === "ENOEXEC"
              ? "Cannot execute script; provide a valid shebang"
              : (error as Error).message,
          ),
        );
        return;
      }
      let cancelled: string | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      const interrupt = (signal: NodeJS.Signals) => {
        cancelled = signal;
        kill(signal);
        escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
      };
      const onInterrupt = () => interrupt("SIGINT");
      const onTerminate = () => interrupt("SIGTERM");
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
      const cleanup = () => {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        if (escalation) clearTimeout(escalation);
      };

      child.once("error", (error) => {
        cleanup();
        reject(failure(error.message));
      });
      child.once("close", (code, signal) => {
        if (cancelled) kill("SIGKILL");
        cleanup();
        if (cancelled || code !== 0)
          reject(
            failure(
              cancelled
                ? `cancelled by ${cancelled}`
                : signal
                  ? `terminated by ${signal}`
                  : `exit code ${code}`,
            ),
          );
        else resolve();
      });
    });
  }
}
