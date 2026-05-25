import { describe, expect, test } from "vitest";

import { automaticRestartBlockedReason, resolveAutoRestartPolicy } from "../src/restart-policy.js";

describe("restart policy", () => {
  test("resolves config defaults, env overrides, and disabled values", () => {
    expect(resolveAutoRestartPolicy({}, {})).toEqual({ enabled: true, idleMs: 600000, maxRestarts: 3 });
    expect(resolveAutoRestartPolicy({ autoRestartIdleMs: 20, maxAutoRestartsPerStep: 4 }, {})).toEqual({ enabled: true, idleMs: 20, maxRestarts: 4 });
    expect(resolveAutoRestartPolicy({ autoRestartIdleMs: 20, maxAutoRestartsPerStep: 4 }, { ROADRUNNER_AUTO_RESTART_IDLE_MS: "0" })).toEqual({ enabled: false, idleMs: 0, maxRestarts: 4 });
    expect(resolveAutoRestartPolicy({}, { ROADRUNNER_AUTO_RESTART_IDLE_MS: "5", ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP: "0" })).toEqual({ enabled: false, idleMs: 5, maxRestarts: 0 });
  });

  test("rejects invalid env overrides and formats block reasons", () => {
    expect(() => resolveAutoRestartPolicy({}, { ROADRUNNER_AUTO_RESTART_IDLE_MS: "bad" })).toThrow(/ROADRUNNER_AUTO_RESTART_IDLE_MS/);
    expect(() => resolveAutoRestartPolicy({}, { ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP: "-1" })).toThrow(/ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP/);
    expect(automaticRestartBlockedReason({ enabled: true, idleMs: 600000, maxRestarts: 3 })).toBe("Provider idle for 10m00s after 3 automatic restarts.");
  });
});
