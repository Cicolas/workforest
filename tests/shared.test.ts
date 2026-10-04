import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createWorktree } from "../src/commands/create/create.ts";
import { initWorkforest } from "../src/commands/init/init.ts";
import { statusWorktrees } from "../src/commands/status/status.ts";
import { syncWorktrees } from "../src/commands/sync/sync.ts";
import {
  parseManifest,
  readManifest,
  writeManifest,
} from "../src/lib/config.ts";
import { serializeManifest, type SharedPath } from "../src/lib/manifest.ts";
import { applySharedLinks } from "../src/lib/shared-links.ts";

const tempDirs: string[] = [];
const header =
  "version: 1\nrepo:\n  name: demo\n  root: /tmp/demo\nworktrees: []\nshared:\n";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "workforest-shared-"));
  tempDirs.push(cwd);
  const main = join(cwd, "main");
  const feature = join(cwd, "feature");
  mkdirSync(main);
  mkdirSync(feature);
  return { cwd, main, feature };
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("shared manifest entries", () => {
  test("accepts mixed shorthand, target mappings, and copy options and preserves them on rewrite", () => {
    const manifest = parseManifest(`${header}  .env: .env
  assets/:
    target: public/
  settings:
    copy: true
    target: "local settings"
  modules:
    target: node_modules
    copy: false
  last: last-target
`);
    expect(manifest.shared).toEqual({
      ".env": ".env",
      "assets/": { target: "public/" },
      settings: { target: "local settings", copy: true },
      modules: { target: "node_modules", copy: false },
      last: "last-target",
    });
    const serialized = serializeManifest(manifest);
    expect(serialized).toContain("  .env: .env\n");
    expect(serialized).toContain(
      '  settings:\n    target: "local settings"\n    copy: true\n',
    );
    expect(parseManifest(serialized)).toEqual(manifest);
  });

  for (const [entry, error] of [
    ["  .env:\n    copy: true\n", "missing target"],
    ["  .env:\n    target: null\n", "missing target"],
    ["  .env:\n    target: .env\n    copy: yes\n", "expected true or false"],
    ['  .env:\n    target: .env\n    copy: "true"\n', "expected true or false"],
    ["  .env:\n    target: .env\n    typo: true\n", "Unknown shared option"],
    ["  .env: .env\n    copy: true\n", "use a target mapping"],
  ]) {
    test(`rejects invalid shared options: ${entry.trim()}`, () => {
      expect(() => parseManifest(header + entry)).toThrow(error);
    });
  }
});

describe("applying shared entries", () => {
  test("creates symlinks for shorthand, target-only, and copy: false entries", () => {
    const { main, feature } = fixture();
    const shared: Record<string, SharedPath> = {
      shorthand: "nested/a",
      mapping: { target: "nested/b" },
      explicit: { target: "nested/c", copy: false },
    };
    for (const source of Object.keys(shared)) {
      writeFileSync(join(main, source), source);
    }
    expect(applySharedLinks(main, feature, shared)).toBe(3);
    for (const [source, entry] of Object.entries(shared)) {
      const target = join(
        feature,
        typeof entry === "string" ? entry : entry.target,
      );
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(resolve(dirname(target), readlinkSync(target))).toBe(
        join(main, source),
      );
    }
    expect(applySharedLinks(main, feature, shared)).toBe(0);
  });

  test("copies files and nested directories independently and replaces existing symlinks safely", () => {
    const { main, feature } = fixture();
    writeFileSync(join(main, ".env"), "original");
    mkdirSync(join(main, "assets", "nested"), { recursive: true });
    writeFileSync(join(main, "assets", "nested", "data"), "asset");
    symlinkSync(join(main, ".env"), join(feature, ".env"));
    symlinkSync(join(main, "assets"), join(feature, "public"));
    const shared = {
      ".env": { target: ".env", copy: true },
      assets: { target: "public", copy: true },
    };
    expect(applySharedLinks(main, feature, shared, [], true)).toBe(2);
    expect(lstatSync(join(feature, ".env")).isFile()).toBe(true);
    expect(lstatSync(join(feature, "public")).isDirectory()).toBe(true);
    expect(
      readFileSync(join(feature, "public", "nested", "data"), "utf8"),
    ).toBe("asset");
    writeFileSync(join(feature, ".env"), "worktree edit");
    expect(readFileSync(join(main, ".env"), "utf8")).toBe("original");
    writeFileSync(join(main, ".env"), "updated");
    writeFileSync(join(feature, "public", "stale"), "stale");
    expect(applySharedLinks(main, feature, shared)).toBe(0);
    expect(readFileSync(join(feature, ".env"), "utf8")).toBe("worktree edit");
    expect(applySharedLinks(main, feature, shared, [], true)).toBe(2);
    expect(readFileSync(join(feature, ".env"), "utf8")).toBe("updated");
    expect(existsSync(join(feature, "public", "stale"))).toBe(false);
  });

  test("expands glob copies, honors exclusions, and skips missing sources", () => {
    const { main, feature } = fixture();
    mkdirSync(join(main, "assets", "nested"), { recursive: true });
    writeFileSync(join(main, "assets", "nested", "data"), "asset");
    const shared = {
      "assets/**/*": { target: "public/", copy: true },
      missing: { target: "missing", copy: true },
    };
    expect(applySharedLinks(main, feature, shared, ["assets/**/*"])).toBe(0);
    expect(existsSync(join(feature, "public"))).toBe(false);
    expect(applySharedLinks(main, feature, shared)).toBe(1);
    const target = join(feature, "public", "nested", "data");
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("asset");
    expect(existsSync(join(feature, "missing"))).toBe(false);
  });

  test("refuses overlapping copy paths before deleting source data", () => {
    const { main, feature } = fixture();
    writeFileSync(join(main, ".env"), "original");
    expect(() =>
      applySharedLinks(
        main,
        feature,
        {
          ".env": { target: join(main, ".env"), copy: true },
        },
        [],
        true,
      ),
    ).toThrow("must not overlap");
    expect(readFileSync(join(main, ".env"), "utf8")).toBe("original");
  });

  test("refreshes individual files within a glob by source or target path and respects exclusions", () => {
    const { main, feature } = fixture();
    mkdirSync(join(main, "assets"));
    writeFileSync(join(main, "assets", "a.txt"), "original a");
    writeFileSync(join(main, "assets", "b.txt"), "original b");
    const shared = { "assets/**/*": { target: "public/", copy: true } };
    applySharedLinks(main, feature, shared);
    writeFileSync(join(main, "assets", "a.txt"), "updated a");
    writeFileSync(join(main, "assets", "b.txt"), "updated b");
    expect(applySharedLinks(main, feature, shared, [], "assets/a.txt")).toBe(1);
    expect(readFileSync(join(feature, "public", "a.txt"), "utf8")).toBe(
      "updated a",
    );
    expect(readFileSync(join(feature, "public", "b.txt"), "utf8")).toBe(
      "original b",
    );
    expect(applySharedLinks(main, feature, shared, ["assets/**/*"], true)).toBe(
      0,
    );
    expect(readFileSync(join(feature, "public", "b.txt"), "utf8")).toBe(
      "original b",
    );
    expect(applySharedLinks(main, feature, shared, [], "public/b.txt")).toBe(1);
    expect(readFileSync(join(feature, "public", "b.txt"), "utf8")).toBe(
      "updated b",
    );
  });
});

describe("shared copies in worktree workflows", () => {
  test("create and sync apply mixed entries and status checks copies without modifying them", async () => {
    const { cwd, main, feature } = fixture();
    git(main, "init", "-b", "main");
    git(main, "config", "user.name", "Workforest Test");
    git(main, "config", "user.email", "workforest@example.com");
    writeFileSync(join(main, "README.md"), "hello");
    git(main, "add", "README.md");
    git(main, "commit", "-m", "Initial commit");
    writeFileSync(join(main, ".env"), "original");
    writeFileSync(join(main, ".env.local"), "local original");
    initWorkforest(cwd, "main");
    const loaded = readManifest(cwd);
    const shared = {
      "README.md": { target: "linked-readme" },
      ".env": { target: ".env", copy: true },
      ".env.local": { target: ".env.local", copy: true },
    };
    writeManifest(loaded.manifestPath, { ...loaded.manifest, shared });
    const result = await createWorktree(cwd, "feature", "feature/copy");
    expect(result.sharedLinksCreated).toBe(3);
    expect(lstatSync(join(feature, "linked-readme")).isSymbolicLink()).toBe(
      true,
    );
    expect(lstatSync(join(feature, ".env")).isFile()).toBe(true);
    expect(readManifest(cwd).manifest.shared).toEqual(shared);
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
    writeFileSync(join(feature, ".env"), "worktree edit");
    expect((await syncWorktrees(cwd)).sharedLinksCreated).toBe(0);
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
    expect(readFileSync(join(feature, ".env"), "utf8")).toBe("worktree edit");
    rmSync(join(feature, ".env"));
    expect(statusWorktrees(cwd).findings).toMatchObject([
      { code: "shared_copy_missing", path: join(feature, ".env") },
    ]);
    expect(existsSync(join(feature, ".env"))).toBe(false);
    symlinkSync(join(main, ".env"), join(feature, ".env"));
    expect(statusWorktrees(cwd).findings[0]?.code).toBe(
      "shared_copy_wrong_type",
    );
    rmSync(join(feature, ".env"));
    mkdirSync(join(feature, ".env"));
    expect(statusWorktrees(cwd).findings[0]?.code).toBe(
      "shared_copy_wrong_type",
    );
    writeFileSync(join(main, ".env"), "updated");
    expect((await syncWorktrees(cwd)).sharedLinksCreated).toBe(0);
    expect(lstatSync(join(feature, ".env")).isDirectory()).toBe(true);
    const cliPath = resolve(import.meta.dir, "../src/cli.ts");
    const runSync = (...args: string[]) => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, cliPath, "sync", ...args],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    writeFileSync(join(feature, ".env.local"), "local edit");
    expect(runSync("--refresh", ".env")).toContain("1 shared path(s) updated");
    expect(readFileSync(join(feature, ".env"), "utf8")).toBe("updated");
    expect(readFileSync(join(feature, ".env.local"), "utf8")).toBe(
      "local edit",
    );
    expect(runSync("--refresh")).toContain("2 shared path(s) updated");
    expect(readFileSync(join(feature, ".env.local"), "utf8")).toBe(
      "local original",
    );
    expect(readManifest(cwd).manifest.shared).toEqual(shared);
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
  });
});
