import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHooks, runHooks } from "../src/lib/hooks.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wf-hooks-"));
  roots.push(root);
  return root;
}
function script(
  root: string,
  event: string,
  name: string,
  body: string,
  executable = true,
) {
  const dir = join(root, ".workforest", event);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, executable ? 0o755 : 0o644);
  return path;
}
test("discover executable direct hooks in filename order and tolerate absent events", () => {
  const root = fixture();
  expect(discoverHooks(root, "pre-create")).toEqual([]);
  script(root, "pre-create", "20-build", "#!/bin/sh\nexit 0\n");
  script(root, "pre-create", "10-install", "#!/bin/sh\nexit 0\n");
  script(root, "pre-create", "README", "documentation", false);
  mkdirSync(join(root, ".workforest", "pre-create", "05-directory"));
  expect(discoverHooks(root, "pre-create").map((hook) => hook.name)).toEqual([
    "10-install",
    "20-build",
  ]);
});

test("run hooks sequentially with context, inherited environment and event working directory", async () => {
  const root = fixture();
  const target = join(root, "target");
  mkdirSync(target);
  script(
    root,
    "post-create",
    "10-context",
    '#!/bin/sh\nprintf "%s\\n" "$WF_EVENT" "$WF_WORKTREE_PATH" "$WF_BRANCH" "$WF_REPO_ROOT" "$WF_MANIFEST_DIR" "$PWD" "$PATH" > context\n',
  );
  script(
    root,
    "post-create",
    "20-append",
    "#!/bin/sh\necho second >> context\n",
  );
  await runHooks({
    event: "post-create",
    worktreePath: target,
    branch: "feature/test",
    repoRoot: root,
    manifestDir: root,
  });
  expect(readFileSync(join(target, "context"), "utf8").split("\n")).toEqual([
    "post-create",
    target,
    "feature/test",
    root,
    root,
    target,
    process.env.PATH!,
    "second",
    "",
  ]);
});

test("selected shebang script runs alone and failures stop later scripts", async () => {
  const root = fixture();
  const context = {
    event: "pre-create" as const,
    worktreePath: join(root, "absent"),
    branch: null,
    repoRoot: root,
    manifestDir: root,
  };
  script(
    root,
    "pre-create",
    "10-fail",
    "#!/bin/sh\necho first >> sequence\nexit 7\n",
  );
  script(
    root,
    "pre-create",
    "20-python",
    '#!/usr/bin/env python3\nfrom pathlib import Path\nPath("python").write_text("shebang")\n',
  );
  await runHooks(context, "20-python");
  expect(readFileSync(join(root, "python"), "utf8")).toBe("shebang");
  await expect(runHooks(context)).rejects.toThrow("10-fail");
  expect(readFileSync(join(root, "sequence"), "utf8")).toBe("first\n");
  await expect(runHooks(context, "../escape")).rejects.toThrow(
    "direct filename",
  );
  script(root, "pre-create", "05-broken", "#!/does/not/exist\n");
  await expect(runHooks(context)).rejects.toThrow("05-broken");
});

test("executable text without a shebang fails instead of implicitly selecting a shell", async () => {
  const root = fixture();
  script(root, "pre-create", "no-interpreter", "echo unexpected > fallback\n");
  await expect(
    runHooks({
      event: "pre-create",
      worktreePath: join(root, "future"),
      branch: null,
      repoRoot: root,
      manifestDir: root,
    }),
  ).rejects.toThrow("shebang");
});
