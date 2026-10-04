import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifest } from "../src/lib/config.ts";
import { discoverRepo } from "../src/lib/git.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wf-hooks-cli-"));
  roots.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.com");
  writeFileSync(join(main, "README"), "initial");
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  writeManifest(join(root, "workforest.yaml"), {
    version: 1,
    repo: { name: "test", root: main },
    worktrees: discoverRepo(main).activeWorktrees,
    shared: {},
  });
  return { root, main };
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
}
function cli(cwd: string, ...args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
}

test("list shared hooks from a worktree without running them or rewriting inventory", () => {
  const { root, main } = fixture();
  const before = readFileSync(join(root, "workforest.yaml"), "utf8");
  script(root, "post-create", "20-last", "#!/bin/sh\ntouch ran\n");
  script(root, "post-create", "10-first", "#!/bin/sh\ntouch ran\n");
  script(root, "post-create", "README", "notes", false);
  const result = cli(main, "hooks", "list");
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain("post-create");
  expect(output.indexOf("10-first")).toBeLessThan(output.indexOf("20-last"));
  expect(output).not.toContain("README");
  expect(existsSync(join(main, "ran"))).toBe(false);
  expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(before);
});

test("manual hooks accept existing branch targets and explicit missing paths without lifecycle mutations", () => {
  const { root, main } = fixture();
  const target = join(root, "missing");
  const before = readFileSync(join(root, "workforest.yaml"), "utf8");
  script(
    root,
    "pre-create",
    "10-context",
    '#!/bin/sh\nprintf "%s\\n" "$WF_EVENT" "$WF_WORKTREE_PATH" "$WF_BRANCH" "$WF_REPO_ROOT" "$WF_MANIFEST_DIR" "$PWD" > "$WF_MANIFEST_DIR/context"\n',
  );
  const result = cli(
    main,
    "hooks",
    "run",
    "pre-create",
    "../missing",
    "--branch",
    "future",
  );
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, "context"), "utf8")).toBe(
    `pre-create\n${target}\nfuture\n${main}\n${root}\n${root}\n`,
  );
  expect(existsSync(target)).toBe(false);
  script(
    root,
    "post-create",
    "10-context",
    '#!/bin/sh\nprintf "%s\\n" "$WF_BRANCH" "$PWD" > "$WF_MANIFEST_DIR/existing"\n',
  );
  expect(cli(root, "hooks", "run", "post-create", "main").exitCode).toBe(0);
  expect(readFileSync(join(root, "existing"), "utf8")).toBe(`main\n${main}\n`);
  expect(readFileSync(join(root, "workforest.yaml"), "utf8")).toBe(before);
});

test("manual selection validates event, script and target and preserves detached branch convention", () => {
  const { root, main } = fixture();
  const detached = join(root, "detached");
  git(main, "worktree", "add", "--detach", detached);
  script(
    root,
    "post-create",
    "10-first",
    '#!/bin/sh\necho unwanted > "$WF_MANIFEST_DIR/unwanted"\n',
  );
  script(
    root,
    "post-create",
    "20-selected",
    '#!/bin/sh\nprintf "branch=%s\\n" "$WF_BRANCH" > "$WF_MANIFEST_DIR/selected"\n',
  );
  expect(
    cli(
      root,
      "hooks",
      "run",
      "post-create",
      detached,
      "--script",
      "20-selected",
    ).exitCode,
  ).toBe(0);
  expect(readFileSync(join(root, "selected"), "utf8")).toBe("branch=\n");
  expect(existsSync(join(root, "unwanted"))).toBe(false);
  for (const args of [
    ["invalid", main],
    ["post-create", "missing"],
    ["post-create", main, "--branch", "override"],
    ["post-create", main, "--script", "../escape"],
    ["post-create", main, "--script", "absent"],
  ])
    expect(cli(root, "hooks", "run", ...args).exitCode).toBe(1);
  script(
    root,
    "post-remove",
    "10-context",
    '#!/bin/sh\nprintf "branch=%s\\n" "$WF_BRANCH" > "$WF_MANIFEST_DIR/removed"\n',
  );
  expect(cli(root, "hooks", "run", "post-remove", "missing").exitCode).toBe(0);
  expect(readFileSync(join(root, "removed"), "utf8")).toBe("branch=\n");
});

test("terminal input and both outputs are inherited and identity precedes script output", () => {
  const { root, main } = fixture();
  script(
    root,
    "post-create",
    "interactive",
    '#!/bin/sh\nread value\nprintf "stdout:%s\\n" "$value"\necho stderr:visible >&2\n',
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "hooks",
      "run",
      "post-create",
      main,
    ],
    {
      cwd: root,
      stdin: new TextEncoder().encode("hello\n"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("stdout:hello");
  expect(result.stdout.toString().indexOf("interactive")).toBeLessThan(
    result.stdout.toString().indexOf("stdout:hello"),
  );
  expect(result.stderr.toString()).toContain("stderr:visible");
});

test("interrupting only the CLI stops the active hook and descendants before later scripts", async () => {
  const { root, main } = fixture();
  const ready = join(root, "ready");
  const delayed = join(root, "delayed");
  script(
    root,
    "post-create",
    "10-wait",
    '#!/bin/sh\ntrap "exit 0" INT TERM\n(sh -c \'trap "" INT TERM; sleep 2; touch "$WF_MANIFEST_DIR/delayed"\') &\necho ready > "$WF_MANIFEST_DIR/ready"\nwait\n',
  );
  script(
    root,
    "post-create",
    "20-later",
    '#!/bin/sh\ntouch "$WF_MANIFEST_DIR/later"\n',
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "hooks",
      "run",
      "post-create",
      main,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    proc.kill("SIGINT");
    const status = await Promise.race([
      proc.exited,
      Bun.sleep(3000).then(() => {
        throw new Error("CLI did not cancel");
      }),
    ]);
    expect(status).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain(
      "cancelled by SIGINT",
    );
    expect(existsSync(join(root, "later"))).toBe(false);
    await Bun.sleep(2200);
    expect(existsSync(delayed)).toBe(false);
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}, 7000);

test("explicit paths discover branch context from an unregistered existing repository", () => {
  const { root, main } = fixture();
  const other = join(root, "other");
  mkdirSync(other);
  git(other, "init", "-b", "separate");
  script(
    root,
    "pre-create",
    "branch",
    '#!/bin/sh\nprintf "%s" "$WF_BRANCH" > "$WF_MANIFEST_DIR/branch"\n',
  );
  expect(cli(root, "hooks", "run", "pre-create", other).exitCode).toBe(0);
  expect(readFileSync(join(root, "branch"), "utf8")).toBe("separate");
});
