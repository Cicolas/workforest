// Narrow subprocess-only faults for otherwise tiny filesystem failure windows.
import { mock } from "bun:test";
import * as fs from "node:fs";
import { dirname } from "node:path";

const target = process.env.WORKFOREST_TEST_OPERATION_TARGET;
const fault = process.env.WORKFOREST_TEST_OPERATION_FAULT;
let manifestStaging: string | undefined;
const original = { ...fs };
mock.module("node:fs", () => ({
  ...original,
  renameSync(source: fs.PathLike, destination: fs.PathLike) {
    original.renameSync(source, destination);
    if (String(destination) === target && fault === "manifest-cleanup") {
      manifestStaging = dirname(String(source));
    }
  },
  rmSync(path: fs.PathLike, options: fs.RmOptions) {
    if (String(path) === manifestStaging && fault === "manifest-cleanup") {
      throw new Error("Injected manifest cleanup failure");
    }
    return original.rmSync(path, options);
  },
  symlinkSync(
    source: fs.PathLike,
    destination: fs.PathLike,
    type?: fs.symlink.Type,
  ) {
    if (String(destination) === target && fault === "link-create") {
      throw new Error("Injected link creation failure");
    }
    return original.symlinkSync(source, destination, type);
  },
}));
