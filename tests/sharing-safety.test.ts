import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readManifest, writeManifest } from "../src/lib/config.ts";
import {
  createSharingFixtureSuite,
  git,
  runCli as run,
  snapshot,
} from "./fixtures/shared-repo.ts";

const { fixture, cleanup } = createSharingFixtureSuite("wf-sharing-safety-");
afterEach(cleanup);

test("invalid glob destinations leave create and sync Git state and manifest unchanged", () => {
  const { cwd, main, feature, manifestPath } = fixture({
    "missing/**/*": "bad",
  });
  const missing = join(cwd, "missing");
  git(main, "worktree", "add", "-b", "stale", missing);
  rmSync(missing, { recursive: true });
  const before = snapshot(main, manifestPath);
  expect(run(cwd, "create", "feature", "feature").exitCode).not.toBe(0);
  expect(snapshot(main, manifestPath)).toEqual(before);
  expect(existsSync(feature)).toBe(false);
  expect(run(cwd, "sync").exitCode).not.toBe(0);
  expect(snapshot(main, manifestPath)).toEqual(before);
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
});

for (const target of [
  "../outside",
  ".",
  ".git",
  ".git/config",
  "nested/../.git",
  "nested/.git/config",
]) {
  test(`create rejects unsafe destination ${target} before creating a branch`, () => {
    const { cwd, main, feature, manifestPath } = fixture({ data: target });
    writeFileSync(join(cwd, "outside"), "independent");
    const before = snapshot(main, manifestPath);
    const result = run(cwd, "create", "feature", "feature");
    expect(result.exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(existsSync(feature)).toBe(false);
    expect(readFileSync(join(cwd, "outside"), "utf8")).toBe("independent");
    expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  });
}

for (const target of [
  "alias/data",
  "alias",
  "alias/child/data",
  "escape/data",
  "metadata/config",
]) {
  test(`sync rejects ancestor alias or source overlap at ${target} before touching earlier entries or pruning`, () => {
    const { cwd, main, feature, manifestPath } = fixture({
      data: "earlier",
      ".": { target, copy: true },
    });
    git(main, "worktree", "add", "-b", "feature", feature);
    const loaded = readManifest(cwd);
    const source = target === "alias" ? "../feature" : ".";
    writeManifest(manifestPath, {
      ...loaded.manifest,
      shared: { data: "earlier", [source]: { target, copy: true } },
    });
    symlinkSync(main, join(feature, "alias"));
    symlinkSync(cwd, join(feature, "escape"));
    symlinkSync(join(main, ".git"), join(feature, "metadata"));
    writeFileSync(join(feature, "earlier"), "independent earlier");
    const missing = join(cwd, "missing");
    git(main, "worktree", "add", "-b", "stale", missing);
    rmSync(missing, { recursive: true });
    const before = snapshot(main, manifestPath);
    expect(run(cwd, "sync", "--refresh").exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
    expect(readFileSync(join(feature, "earlier"), "utf8")).toBe(
      "independent earlier",
    );
  });
}

for (const target of ["collision", "collision/child"]) {
  test(`overlapping planned destinations ${target} are rejected before replacing the first entry`, () => {
    const { cwd, main, feature, manifestPath } = fixture({
      data: "collision",
      missing: target,
    });
    git(main, "worktree", "add", "-b", "feature", feature);
    writeFileSync(join(feature, "collision"), "local");
    const before = snapshot(main, manifestPath);
    expect(run(cwd, "sync").exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(readFileSync(join(feature, "collision"), "utf8")).toBe("local");
  });
}

test("safe destination symlink replacement and external sources preserve referents", () => {
  const { cwd, main, feature } = fixture({
    data: { target: "copied", copy: true },
    "../external": "external",
  });
  git(main, "worktree", "add", "-b", "feature", feature);
  writeFileSync(join(cwd, "external"), "outside source");
  symlinkSync(join(main, "data"), join(feature, "copied"));
  expect(run(cwd, "sync", "--refresh").exitCode).toBe(0);
  expect(lstatSync(join(feature, "copied")).isFile()).toBe(true);
  expect(readFileSync(join(feature, "copied"), "utf8")).toBe("source");
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  expect(readFileSync(join(cwd, "external"), "utf8")).toBe("outside source");
  expect(readFileSync(join(feature, "external"), "utf8")).toBe(
    "outside source",
  );
  expect(readManifest(cwd).manifest.worktrees).toHaveLength(2);
});

test("create inspects symlinked checkout ancestors before applying sharing", () => {
  const { cwd, main, feature, manifestPath } = fixture({
    data: "tracked-alias/data",
  });
  symlinkSync(main, join(main, "tracked-alias"));
  git(main, "add", "tracked-alias");
  git(main, "commit", "-m", "Track alias fixture");
  const beforeManifest = readFileSync(manifestPath, "utf8");
  expect(run(cwd, "create", "feature", "feature").exitCode).not.toBe(0);
  expect(existsSync(feature)).toBe(true);
  expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  expect(lstatSync(join(main, "data")).isFile()).toBe(true);
  expect(readFileSync(manifestPath, "utf8")).toBe(beforeManifest);
});

for (const [source, target] of [
  ["../feature/data", "data"],
  ["../feature", "nested"],
  ["../feature/nested/data", "nested"],
  ["source-alias", "data"],
]) {
  test(`sync rejects source identity or parent-child overlap ${source} -> ${target}`, () => {
    const { cwd, main, feature, manifestPath } = fixture({ [source]: target });
    git(main, "worktree", "add", "-b", "feature", feature);
    mkdirSync(join(feature, "nested"));
    writeFileSync(join(feature, "nested", "data"), "nested local");
    symlinkSync(join(feature, "data"), join(main, "source-alias"));
    const before = snapshot(main, manifestPath);
    expect(run(cwd, "sync").exitCode).not.toBe(0);
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(readFileSync(join(feature, "data"), "utf8")).toBe("source");
    expect(readFileSync(join(feature, "nested", "data"), "utf8")).toBe(
      "nested local",
    );
    expect(readFileSync(join(main, "data"), "utf8")).toBe("source");
  });
}

for (const parentFirst of [true, false]) {
  test(`sync rejects lexically overlapping targets through an existing alias (${parentFirst ? "parent" : "child"} first)`, () => {
    const shared = parentFirst
      ? { assets: "redirect", "other-config": "redirect/config" }
      : { "other-config": "redirect/config", assets: "redirect" };
    const { cwd, main, feature, manifestPath } = fixture(shared);
    mkdirSync(join(main, "assets"));
    writeFileSync(join(main, "assets", "config"), "source config preserved");
    writeFileSync(join(main, "other-config"), "other config preserved");
    git(main, "worktree", "add", "-b", "feature", feature);
    mkdirSync(join(feature, "safe"));
    writeFileSync(join(feature, "safe", "config"), "independent safe config");
    symlinkSync("safe", join(feature, "redirect"));
    const before = snapshot(main, manifestPath);
    const result = run(cwd, "sync");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Shared targets must not overlap",
    );
    expect(result.stderr.toString()).not.toContain("Partial completion");
    expect(snapshot(main, manifestPath)).toEqual(before);
    expect(lstatSync(join(main, "assets")).isDirectory()).toBe(true);
    expect(lstatSync(join(main, "assets", "config")).isFile()).toBe(true);
    expect(readFileSync(join(main, "assets", "config"), "utf8")).toBe(
      "source config preserved",
    );
    expect(readFileSync(join(main, "other-config"), "utf8")).toBe(
      "other config preserved",
    );
    expect(lstatSync(join(feature, "redirect")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(feature, "redirect"))).toBe("safe");
    expect(readFileSync(join(feature, "safe", "config"), "utf8")).toBe(
      "independent safe config",
    );
  });
}
