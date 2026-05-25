import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { loadContext } from "../src/config.js";
import { createRunSessionLogger } from "../src/run-session-log.js";
import { removeDir, tempDir } from "./helpers.js";

describe("run session log", () => {
  test("writes human and machine-readable run events", async () => {
    const directory = await tempDir("roadrunner-session-log-");
    const dates = [new Date("2026-05-25T12:30:00.123Z"), new Date("2026-05-25T12:30:01.456Z")];
    try {
      const context = await loadContext(directory, { _: [] });
      const logger = await createRunSessionLogger(context, () => dates.shift()!);

      logger.event("run-start", "run started root=/project", { root: "/project" });
      logger.event("provider-start", "provider started role=plan pid=123", { pid: 123, role: "plan" });
      await logger.close();

      expect(await readFile(logger.sessionLogPath, "utf8")).toBe("[12:30:00.123] run started root=/project\n[12:30:01.456] provider started role=plan pid=123\n");
      const events = (await readFile(logger.eventsLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toEqual([
        { root: "/project", time: "2026-05-25T12:30:00.123Z", type: "run-start" },
        { pid: 123, role: "plan", time: "2026-05-25T12:30:01.456Z", type: "provider-start" },
      ]);
    } finally {
      await removeDir(directory);
    }
  });

  test("uses defaults for timestamps and payloads", async () => {
    const directory = await tempDir("roadrunner-session-log-defaults-");
    try {
      const context = await loadContext(directory, { _: [] });
      const logger = await createRunSessionLogger(context);

      logger.event("heartbeat", "heartbeat received");
      await logger.close();

      expect(await readFile(logger.sessionLogPath, "utf8")).toMatch(/heartbeat received/);
      const event = JSON.parse((await readFile(logger.eventsLogPath, "utf8")).trim());
      expect(event).toMatchObject({ type: "heartbeat" });
      expect(typeof event.time).toBe("string");
    } finally {
      await removeDir(directory);
    }
  });
});
