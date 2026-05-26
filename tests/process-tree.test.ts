import { describe, expect, test, vi } from "vitest";

import { processTreeExists, signalProcessTree, windowsTaskkillArgs } from "../src/infrastructure/process-tree.js";

const testPosix = process.platform === "win32" ? test.skip : test;

describe("process tree helpers", () => {
  test("builds Windows taskkill arguments", () => {
    expect(windowsTaskkillArgs(123, "SIGTERM")).toEqual(["/PID", "123", "/T"]);
    expect(windowsTaskkillArgs(123, "SIGKILL")).toEqual(["/PID", "123", "/T", "/F"]);
  });

  testPosix("signals POSIX process groups and reports missing groups", () => {
    const kill = vi.spyOn(process, "kill");
    try {
      expect(signalProcessTree(undefined, "SIGTERM")).toBe(false);

      kill.mockImplementationOnce(() => true);
      expect(signalProcessTree(123, "SIGTERM")).toBe(true);
      expect(kill).toHaveBeenLastCalledWith(-123, "SIGTERM");

      kill.mockImplementationOnce(() => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      });
      expect(signalProcessTree(123, "SIGTERM")).toBe(false);

      kill.mockImplementationOnce(() => {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      });
      expect(() => signalProcessTree(123, "SIGTERM")).toThrow(/denied/);
    } finally {
      kill.mockRestore();
    }
  });

  testPosix("probes POSIX process groups", () => {
    const kill = vi.spyOn(process, "kill");
    try {
      expect(processTreeExists(undefined)).toBe(false);

      kill.mockImplementationOnce(() => true);
      expect(processTreeExists(456)).toBe(true);
      expect(kill).toHaveBeenLastCalledWith(-456, 0);

      kill.mockImplementationOnce(() => {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      });
      expect(processTreeExists(456)).toBe(true);

      kill.mockImplementationOnce(() => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      });
      expect(processTreeExists(456)).toBe(false);

      kill.mockImplementationOnce(() => {
        const error = new Error("unexpected") as NodeJS.ErrnoException;
        error.code = "EINVAL";
        throw error;
      });
      expect(() => processTreeExists(456)).toThrow(/unexpected/);
    } finally {
      kill.mockRestore();
    }
  });
});
