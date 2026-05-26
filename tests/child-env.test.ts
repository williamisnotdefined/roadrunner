import { describe, expect, test } from "vitest";

import { providerChildEnv, verificationChildEnv } from "../src/infrastructure/child-env.js";

describe("child environments", () => {
  test("passes provider credentials and explicit Roadrunner controls", () => {
    expect(
      providerChildEnv({
        OPENAI_API_KEY: "openai",
        PATH: "/bin",
        ROADRUNNER_PROVIDER_TIMEOUT_MS: "123",
        ROADRUNNER_SECRET: "secret",
        UNTRUSTED_SECRET: "nope",
      }),
    ).toEqual({ OPENAI_API_KEY: "openai", PATH: "/bin", ROADRUNNER_PROVIDER_TIMEOUT_MS: "123" });
  });

  test("keeps fake provider controls only in test environments", () => {
    expect(providerChildEnv({ NODE_ENV: "test", ROADRUNNER_FAKE_OPENCODE_MODE: "success" })).toEqual({ ROADRUNNER_FAKE_OPENCODE_MODE: "success" });
    expect(providerChildEnv({ ROADRUNNER_FAKE_OPENCODE_MODE: "success" })).toEqual({});
  });

  test("lets explicit provider env override inherited values", () => {
    expect(providerChildEnv({ ROADRUNNER_PROVIDER_TIMEOUT_MS: "1" }, { ROADRUNNER_PROVIDER_TIMEOUT_MS: "2" })).toEqual({ ROADRUNNER_PROVIDER_TIMEOUT_MS: "2" });
  });

  test("keeps verification commands on the base environment only", () => {
    expect(verificationChildEnv({ LC_ALL: "C", PATH: "/bin", ROADRUNNER_PROVIDER_TIMEOUT_MS: "123" })).toEqual({ LC_ALL: "C", PATH: "/bin" });
  });
});
