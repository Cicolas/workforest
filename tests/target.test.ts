import { describe, expect, test } from "bun:test";

import type { WorktreeEntry } from "../src/lib/manifest.ts";
import {
  resolveWorktreeTarget,
  TargetResolutionError,
} from "../src/lib/target.ts";

const entries: WorktreeEntry[] = [
  { path: "/repo/main", branch: "main", isMain: true },
  { path: "/repo/auth", branch: "feature/auth", isMain: false },
];

describe("resolveWorktreeTarget", () => {
  test("resolves absolute paths, relative paths, and branch names", () => {
    for (const target of ["/repo/auth", "../auth", "feature/auth"]) {
      expect(resolveWorktreeTarget("/repo/main", target, entries)).toEqual(
        entries[1],
      );
    }
  });

  test("normalizes paths and deduplicates manifest and Git entries", () => {
    expect(
      resolveWorktreeTarget("/repo", "./main/../auth", [
        ...entries,
        { ...entries[1], path: "/repo/./auth" },
      ]).branch,
    ).toBe("feature/auth");
  });

  test("reports all distinct paths for an ambiguous branch", () => {
    try {
      resolveWorktreeTarget("/repo", "feature/auth", [
        ...entries,
        { ...entries[1], path: "/repo/other" },
      ]);
      throw new Error("Expected ambiguous target to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TargetResolutionError);
      const targetError = error as TargetResolutionError;
      expect(targetError.code).toBe("target_ambiguous");
      expect(targetError.matches).toHaveLength(2);
      expect(targetError.message).toContain("/repo/auth");
      expect(targetError.message).toContain("/repo/other");
    }
  });

  test("rejects unknown targets", () => {
    expect(() => resolveWorktreeTarget("/repo", "unknown", entries)).toThrow(
      "No worktree matches target: unknown",
    );
  });
});
