// Subprocess-only filesystem faults. Production code has no testing hooks.
import { mock } from "bun:test";
import * as fs from "node:fs";
import { dirname } from "node:path";

const target = process.env.WORKFOREST_TEST_COPY_TARGET;
const fault = process.env.WORKFOREST_TEST_COPY_FAULT;
let installs = 0;
let staging: string | undefined;
const original = { ...fs };
mock.module("node:fs", () => ({
  ...original,
  cpSync(
    source: fs.PathLike,
    destination: fs.PathLike,
    options: fs.CopySyncOptions,
  ) {
    staging = dirname(String(destination));
    return original.cpSync(source, destination, options);
  },
  renameSync(source: fs.PathLike, destination: fs.PathLike) {
    if (String(destination) === target) {
      installs += 1;
      if (
        (installs === 1 && fault !== "cleanup-success") ||
        (fault === "restore" && installs === 2)
      ) {
        throw new Error("Injected copy rename failure");
      }
    }
    return original.renameSync(source, destination);
  },
  rmSync(path: fs.PathLike, options: fs.RmOptions) {
    if (String(path) === staging && fault?.startsWith("cleanup")) {
      throw new Error("Injected copy cleanup failure");
    }
    return original.rmSync(path, options);
  },
}));
