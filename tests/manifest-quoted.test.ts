import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  parseManifest,
  readManifest,
  writeManifest,
} from "../src/lib/config.ts";
import {
  serializeManifest,
  type WorkforestManifest,
} from "../src/lib/manifest.ts";

describe("quoted manifest names", () => {
  test("preserves empty descriptions and omits descriptions that are not set", () => {
    const manifest: WorkforestManifest = {
      version: 1,
      repo: { name: "demo", root: "/tmp/demo" },
      worktrees: [
        { path: "/tmp/demo", branch: "main", isMain: true, description: "" },
        { path: "/tmp/feature", branch: "feature", isMain: false },
      ],
      shared: {},
    };
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  test("decodes doubled apostrophes in single-quoted keys and values", () => {
    const manifest = parseManifest(`version: 1
repo:
  name: 'demo''s repo'
  root: /tmp/demo
worktrees:
  - path: /tmp/demo/feature
    branch: null
    isMain: false
    description: 'owner''s: feature work'
    ignoreShared:
      - 'owner''s:local'
shared:
  'owner''s:local': 'target''s:local'
  'copy''s:name':
    target: 'copied''s:name'
    copy: true
`);
    expect(manifest.repo.name).toBe("demo's repo");
    expect(manifest.worktrees[0].description).toBe("owner's: feature work");
    expect(manifest.shared).toEqual({
      "owner's:local": "target's:local",
      "copy's:name": { target: "copied's:name", copy: true },
    });
    expect(manifest.worktrees[0].ignoreShared).toEqual(["owner's:local"]);
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  test("round-trips colons, spaces, escaped quotes, scalar-like strings, and exclusions", () => {
    const manifest: WorkforestManifest = {
      version: 1,
      repo: { name: "quoted fixture", root: "/tmp/quoted fixture" },
      worktrees: [
        {
          path: "/tmp/quoted fixture/main",
          branch: "true",
          isMain: true,
          description: 'Fix "login": keep # notes\nSecond line',
          ignoreShared: ["settings:local", 'quote":after', "true", "null"],
        },
      ],
      shared: {
        "settings:local": "target:local",
        "space name": { target: "space target" },
        'quote":after': { target: 'target "quoted"', copy: true },
        true: { target: "false", copy: false },
        null: "true",
        plain: "ordinary",
      },
    };
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(cwd: string, command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).not.toContain("error:");
  expect(result.exitCode).toBe(0);
  return result;
}

function cli(cwd: string, ...args: string[]) {
  return run(cwd, [
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    ...args,
  ]);
}

test("CLI creation and sync preserve colon-containing policy, sources, targets, and exclusions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "workforest-quoted-"));
  tempDirs.push(cwd);
  const main = join(cwd, "main");
  const feature = join(cwd, "feature");
  mkdirSync(main);
  const git = (...args: string[]) => run(main, ["git", ...args]);
  git("init", "-b", "main");
  git("config", "user.name", "Workforest Test");
  git("config", "user.email", "workforest@example.com");
  writeFileSync(join(main, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "Initial commit");
  cli(cwd, "init", main);
  const { manifestPath, manifest } = readManifest(cwd);
  manifest.shared = {
    "settings:local": "target:local",
    'copy":config': { target: 'copy":target', copy: true },
    "excluded:local": "excluded:target",
  };
  writeFileSync(join(main, "settings:local"), "shared settings\n");
  writeFileSync(join(main, 'copy":config'), "copied settings\n");
  writeFileSync(join(main, "excluded:local"), "excluded source\n");
  writeManifest(manifestPath, manifest);
  cli(cwd, "create", feature, "feature/quoted");
  const created = readManifest(cwd).manifest;
  created.worktrees.find((entry) => entry.path === feature)!.ignoreShared = [
    "excluded:local",
  ];
  writeManifest(manifestPath, created);
  rmSync(join(feature, "excluded:target"));
  writeFileSync(
    join(feature, "excluded:target"),
    "independent local settings\n",
  );
  writeFileSync(join(feature, 'copy":target'), "independent copy\n");
  cli(cwd, "sync");
  const rewritten = readManifest(cwd).manifest;
  expect(rewritten.version).toBe(1);
  expect(rewritten.shared).toEqual(manifest.shared);
  expect(
    rewritten.worktrees.find((entry) => entry.path === feature)!.ignoreShared,
  ).toEqual(["excluded:local"]);
  const link = join(feature, "target:local");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(resolve(dirname(link), readlinkSync(link))).toBe(
    join(main, "settings:local"),
  );
  expect(readFileSync(link, "utf8")).toBe("shared settings\n");
  expect(readFileSync(join(main, "settings:local"), "utf8")).toBe(
    "shared settings\n",
  );
  expect(lstatSync(join(feature, 'copy":target')).isFile()).toBe(true);
  expect(readFileSync(join(feature, 'copy":target'), "utf8")).toBe(
    "independent copy\n",
  );
  expect(readFileSync(join(main, 'copy":config'), "utf8")).toBe(
    "copied settings\n",
  );
  expect(readFileSync(join(feature, "excluded:target"), "utf8")).toBe(
    "independent local settings\n",
  );
  expect(JSON.parse(cli(cwd, "status", "--json").stdout.toString())).toEqual({
    level: "ok",
    findings: [],
  });
});
