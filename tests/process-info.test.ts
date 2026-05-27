import { describe, expect, test } from "vitest";

import { processIdentityStatus, readProcessInfo } from "../src/infrastructure/process-info.js";

describe("process info", () => {
  test("reads Linux process identity and classifies identity status", async () => {
    const current = await readProcessInfo(process.pid);

    expect(await readProcessInfo(0)).toBeNull();
    expect(current?.processGroupId).toEqual(expect.any(Number));
    expect(current?.startTimeTicks).toEqual(expect.any(String));
    expect(await processIdentityStatus({ pid: process.pid, startTimeTicks: current!.startTimeTicks })).toBe("same");
    expect(await processIdentityStatus({ pid: process.pid })).toBe("unverifiable");
    expect(await processIdentityStatus({ pid: process.pid, startTimeTicks: "definitely-not-current" })).toBe("different");
    expect(await processIdentityStatus({ pid: 99999999, startTimeTicks: "missing" })).toBe("missing");
  });
});
