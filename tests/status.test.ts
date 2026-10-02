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
import { join, relative, resolve } from "node:path";

import { writeManifest } from "../src/config.ts";
import { discoverRepo } from "../src/git.ts";
import type { WorkforestManifest } from "../src/manifest.ts";
import { applySharedLinks } from "../src/shared-links.ts";
import { statusErrorResult, statusWorktrees } from "../src/status.ts";
import { TargetResolutionError } from "../src/target.ts";

const tempDirs: string[] = [];
const cliPath = resolve(import.meta.dir, "../src/cli.ts");

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "workforest-status-"));
  tempDirs.push(cwd);
  const main = join(cwd, "main");
  const feature = join(cwd, "feature");
  const manifestPath = join(cwd, "workforest.yaml");
  mkdirSync(main);
  git(main, ["init", "-b", "main"]);
  git(main, ["config", "user.name", "Workforest Test"]);
  git(main, ["config", "user.email", "workforest@example.com"]);
  writeFileSync(join(main, "README.md"), "status fixture\n");
  git(main, ["add", "README.md"]);
  git(main, ["commit", "-m", "Initial commit"]);
  git(main, ["worktree", "add", "-b", "feature/demo", feature]);
  writeFileSync(join(main, ".env"), "EXAMPLE=value\n");
  const manifest: WorkforestManifest = {
    version: 1,
    repo: { name: "status-fixture", root: main },
    worktrees: discoverRepo(main).activeWorktrees,
    shared: { ".env": ".env" },
  };
  writeManifest(manifestPath, manifest);
  applySharedLinks(main, feature, manifest.shared);
  return { cwd, main, feature, manifest, manifestPath };
}

function runCli(cwd: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliPath, "status", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("statusWorktrees", () => {
  test("returns ok for healthy links, including absolute symlinks", () => {
    const { cwd, main, feature } = fixture();
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
    rmSync(join(feature, ".env"));
    symlinkSync(join(main, ".env"), join(feature, ".env"));
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
  });

  test("reports a deleted directory without pruning the Git registration", () => {
    const { cwd, main, feature, manifestPath } = fixture();
    const beforeManifest = readFileSync(manifestPath, "utf8");
    rmSync(feature, { recursive: true });
    const beforeGit = git(main, ["worktree", "list", "--porcelain"]);

    expect(statusWorktrees(cwd)).toEqual({
      level: "warning",
      findings: [
        {
          code: "worktree_path_missing",
          path: feature,
          branch: "feature/demo",
          message: "Manifest entry path does not exist on disk.",
        },
      ],
    });
    expect(git(main, ["worktree", "list", "--porcelain"])).toBe(beforeGit);
    expect(readFileSync(manifestPath, "utf8")).toBe(beforeManifest);
    expect(existsSync(feature)).toBe(false);
  });

  test("detects a manifest worktree removed from Git and missing on disk", () => {
    const { cwd, main, feature } = fixture();
    git(main, ["worktree", "remove", "--force", feature]);
    const result = statusWorktrees(cwd);
    expect(result.level).toBe("warning");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "manifest_missing_git_worktree",
      "worktree_path_missing",
    ]);
  });

  test("detects a Git-only worktree and resolves it as a target", () => {
    const { cwd, main } = fixture();
    const extra = join(cwd, "extra");
    git(main, ["worktree", "add", "-b", "feature/extra", extra]);
    const expected = {
      level: "warning",
      findings: [
        {
          code: "git_missing_manifest_worktree",
          path: extra,
          branch: "feature/extra",
          message: "Git worktree is missing from the manifest.",
        },
      ],
    };
    expect(statusWorktrees(cwd)).toEqual(expected);
    expect(statusWorktrees(cwd, "feature/extra")).toEqual(expected);
  });

  test("reports missing shared links and never creates them", () => {
    const { cwd, feature } = fixture();
    const target = join(feature, ".env");
    rmSync(target);
    const result = statusWorktrees(cwd);
    expect(result.level).toBe("warning");
    expect(result.findings.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "shared_link_missing", path: target },
    ]);
    expect(existsSync(target)).toBe(false);
  });

  for (const kind of ["file", "directory"]) {
    test(`reports a shared link replaced with a ${kind} without removing it`, () => {
      const { cwd, feature } = fixture();
      const target = join(feature, ".env");
      rmSync(target);
      if (kind === "file") {
        writeFileSync(target, "local contents");
      } else {
        mkdirSync(target);
      }
      expect(statusWorktrees(cwd).findings[0].code).toBe(
        "shared_link_wrong_type",
      );
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      if (kind === "file") {
        expect(readFileSync(target, "utf8")).toBe("local contents");
      }
    });
  }

  test("reports dangling symlinks as wrong targets and preserves them", () => {
    const { cwd, feature } = fixture();
    const target = join(feature, ".env");
    rmSync(target);
    symlinkSync("../absent/.env", target);
    const result = statusWorktrees(cwd);
    expect(result.findings[0].code).toBe("shared_link_wrong_target");
    expect(readlinkSync(target)).toBe("../absent/.env");
  });

  test("respects ignoreShared, missing sources, and the main-worktree exemption", () => {
    const { cwd, feature, manifest, manifestPath } = fixture();
    rmSync(join(feature, ".env"));
    manifest.worktrees.find((entry) => entry.path === feature)!.ignoreShared = [
      ".env",
    ];
    manifest.shared["missing-source"] = "missing-target";
    writeManifest(manifestPath, manifest);
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
  });

  test("uses the same recursive glob expansion as sync and sorts findings", () => {
    const { cwd, main, feature, manifest, manifestPath } = fixture();
    mkdirSync(join(main, "assets", "nested"), { recursive: true });
    writeFileSync(join(main, "assets", "z.txt"), "z");
    writeFileSync(join(main, "assets", "nested", "a.txt"), "a");
    manifest.shared["assets/**/*"] = "shared/";
    manifest.shared["absent/**/*"] = "absent/";
    writeManifest(manifestPath, manifest);
    applySharedLinks(main, feature, manifest.shared);
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
    rmSync(join(feature, "shared", "nested", "a.txt"));
    rmSync(join(feature, "shared", "z.txt"));
    const result = statusWorktrees(cwd);
    expect(result.findings.map((finding) => finding.path)).toEqual([
      join(feature, "shared", "nested", "a.txt"),
      join(feature, "shared", "z.txt"),
    ]);
    manifest.worktrees.find((entry) => entry.path === feature)!.ignoreShared = [
      "assets/**/*",
    ];
    writeManifest(manifestPath, manifest);
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
  });

  test("reports a nested shared link blocked by a regular file as missing", () => {
    const { cwd, main, feature, manifest, manifestPath } = fixture();
    manifest.shared[".env"] = "shared/.env";
    writeManifest(manifestPath, manifest);
    writeFileSync(join(feature, "shared"), "blocking file");
    const result = statusWorktrees(cwd);
    expect(result.findings[0].code).toBe("shared_link_missing");
    expect(result.findings[0].path).toBe(join(feature, "shared", ".env"));
    expect(readFileSync(join(main, ".env"), "utf8")).toBe("EXAMPLE=value\n");
  });

  test("restricts branch, absolute path, and relative path targets to one worktree", () => {
    const { cwd, feature } = fixture();
    rmSync(join(feature, ".env"));
    expect(statusWorktrees(cwd, "main")).toEqual({ level: "ok", findings: [] });
    expect(statusWorktrees(cwd, "feature/demo")).toEqual(
      statusWorktrees(cwd, feature),
    );
    expect(statusWorktrees(cwd, "./feature/../feature")).toEqual(
      statusWorktrees(cwd, feature),
    );
  });

  test("discovers the manifest and resolves paths relative to a nested working directory", () => {
    const { cwd, feature } = fixture();
    const nested = join(feature, "nested");
    mkdirSync(nested);
    expect(statusWorktrees(nested, "..")).toEqual({
      level: "ok",
      findings: [],
    });
    expect(statusWorktrees(nested)).toEqual(statusWorktrees(cwd));
  });

  test("normalizes manifest paths before comparing them with Git", () => {
    const { cwd, feature, manifest, manifestPath } = fixture();
    manifest.worktrees.find((entry) => entry.path === feature)!.path =
      `${feature}/../feature`;
    writeManifest(manifestPath, manifest);
    expect(statusWorktrees(cwd)).toEqual({ level: "ok", findings: [] });
  });

  test("reports every path for an ambiguous branch and errors for unsupported targets", () => {
    const { cwd, main, feature, manifest, manifestPath } = fixture();
    const duplicate = join(cwd, "duplicate");
    git(main, ["worktree", "add", "--force", duplicate, "feature/demo"]);
    let ambiguous: unknown;
    try {
      statusWorktrees(cwd, "feature/demo");
    } catch (error) {
      ambiguous = error;
    }
    expect(ambiguous).toBeInstanceOf(TargetResolutionError);
    const result = statusErrorResult(ambiguous);
    expect(result.level).toBe("error");
    expect(result.findings.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "target_ambiguous", path: feature },
      { code: "target_ambiguous", path: duplicate },
    ]);
    expect((ambiguous as Error).message).toContain(feature);
    expect((ambiguous as Error).message).toContain(duplicate);
    expect(() => statusWorktrees(cwd, "not-a-worktree")).toThrow(
      "No worktree matches",
    );
    expect(statusWorktrees(cwd, feature)).toEqual({
      level: "ok",
      findings: [],
    });
    expect(readFileSync(manifestPath, "utf8")).toContain(manifest.repo.name);
  });
});

describe("wf status", () => {
  test("prints a stable clean summary and exact JSON schema with exit 0", () => {
    const { cwd } = fixture();
    const human = runCli(cwd);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.toString()).toBe("STATUS ok (0 finding(s))\n");
    expect(human.stderr.toString()).toBe("");
    const json = runCli(cwd, "--json");
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout.toString())).toEqual({
      level: "ok",
      findings: [],
    });
    expect(json.stderr.toString()).toBe("");
  });

  test("emits exact warning JSON and stable human findings with exit 1", () => {
    const { cwd, feature } = fixture();
    rmSync(feature, { recursive: true });
    const result = runCli(cwd, "--json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      level: "warning",
      findings: [
        {
          code: "worktree_path_missing",
          path: feature,
          branch: "feature/demo",
          message: "Manifest entry path does not exist on disk.",
        },
      ],
    });
    expect(runCli(cwd).stdout.toString()).toBe(
      `STATUS warning (1 finding(s))\n- ${feature}: worktree_path_missing\n`,
    );
  });

  test("resolves target paths relative to the invocation directory", () => {
    const { cwd, feature, main } = fixture();
    rmSync(join(feature, ".env"));
    const result = runCli(main, relative(main, feature), "--json");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toEqual(
      statusWorktrees(cwd, feature),
    );
    expect(runCli(cwd, "main", "--json").exitCode).toBe(0);
  });

  test("prints ambiguous paths in JSON and one primary error with exit 2", () => {
    const { cwd, main, feature } = fixture();
    const duplicate = join(cwd, "duplicate");
    git(main, ["worktree", "add", "--force", duplicate, "feature/demo"]);
    const result = runCli(cwd, "feature/demo", "--json");
    expect(result.exitCode).toBe(2);
    const json = JSON.parse(result.stdout.toString());
    expect(Object.keys(json)).toEqual(["level", "findings"]);
    expect(json.level).toBe("error");
    expect(
      json.findings.map((finding: { code: string; path: string }) => ({
        code: finding.code,
        path: finding.path,
      })),
    ).toEqual([
      { code: "target_ambiguous", path: feature },
      { code: "target_ambiguous", path: duplicate },
    ]);
    expect(result.stderr.toString().trim().split("\n")).toHaveLength(1);
    expect(result.stderr.toString()).toContain(feature);
    expect(result.stderr.toString()).toContain(duplicate);
  });

  for (const failure of ["missing", "invalid", "git", "target"]) {
    test(`returns structured error and exit 2 for ${failure} failure`, () => {
      const { cwd, manifestPath, manifest } = fixture();
      let args = ["--json"];
      if (failure === "missing") {
        rmSync(manifestPath);
      } else if (failure === "invalid") {
        writeFileSync(manifestPath, "version: 999\n");
      } else if (failure === "git") {
        manifest.repo.root = join(cwd, "absent");
        writeManifest(manifestPath, manifest);
      } else {
        args = ["unknown-target", "--json"];
      }
      const result = runCli(cwd, ...args);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        level: "error",
        findings: [],
      });
      expect(result.stderr.toString().trim().split("\n")).toHaveLength(1);
      expect(result.stderr.toString().trim().length).toBeGreaterThan(0);
    });
  }

  test("returns exit 2 for unknown flags", () => {
    const { cwd } = fixture();
    const result = runCli(cwd, "--unsupported");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("unknown option");
    const json = runCli(cwd, "--unsupported", "--json");
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout.toString())).toEqual({
      level: "error",
      findings: [],
    });
    expect(json.stderr.toString().trim().split("\n")).toHaveLength(1);
  });
});
