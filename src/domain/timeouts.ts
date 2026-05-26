import { parseNonNegativeIntegerValue } from "./numeric-options.js";

const defaultVerificationTimeoutMs = 10 * 60 * 1000;
const defaultProviderTimeoutMs = 30 * 60 * 1000;
const defaultOpenCodeCheckTimeoutMs = 10_000;

export function providerEnvForDeadline(deadline: number | null | undefined): Record<string, string> {
  if (deadline === null || deadline === undefined) return {};
  const remaining = remainingDeadlineMs(deadline);
  const configured = providerTimeoutMs(process.env.ROADRUNNER_PROVIDER_TIMEOUT_MS);
  return { ROADRUNNER_PROVIDER_TIMEOUT_MS: String(configured === 0 ? remaining : Math.max(1, Math.min(configured, remaining))) };
}

export function verificationTimeoutMs(deadline: number | null | undefined): number {
  const configured = parseNonNegativeIntegerValue("ROADRUNNER_VERIFY_TIMEOUT_MS", process.env.ROADRUNNER_VERIFY_TIMEOUT_MS, defaultVerificationTimeoutMs);
  if (deadline === null || deadline === undefined) return configured;
  const remaining = remainingDeadlineMs(deadline);
  if (configured === 0) return remaining;
  return Math.max(1, Math.min(configured, remaining));
}

export function providerTimeoutMs(value: string | undefined): number {
  return parseNonNegativeIntegerValue("ROADRUNNER_PROVIDER_TIMEOUT_MS", value, defaultProviderTimeoutMs);
}

export function openCodeCheckTimeoutMs(value: string | undefined): number {
  if (value === undefined) return defaultOpenCodeCheckTimeoutMs;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS must be a positive integer, got ${value}.`);
  return timeoutMs;
}

function remainingDeadlineMs(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error("Roadrunner deadline exceeded.");
  return remaining;
}
