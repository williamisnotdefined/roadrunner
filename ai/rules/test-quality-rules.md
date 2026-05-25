# Test Quality Rules

## Purpose

- Treat coverage as a guardrail, not the definition of quality.
- Prefer tests that prove behavior, failure handling, and regression protection.
- Keep the coverage threshold at 95% unless there is an explicit product reason to change it.

## Always

- Test observable behavior through public functions, CLI commands, or documented file outputs.
- Include meaningful failure cases for critical flows such as provider exits, timeouts, invalid queues, lock handling, and cleanup.
- Use deterministic fake providers and temporary directories for autonomous-run scenarios.
- Assert final state and important side effects, not just that a branch executed.
- When coverage exposes a gap, first decide whether the gap is a real risk before adding a test.

## Never

- Do not write tests whose only purpose is to satisfy a coverage counter.
- Do not add brittle tests for platform races, impossible process states, or implementation details that do not affect behavior.
- Do not add `v8 ignore` just to preserve an arbitrary metric.
- Do not weaken assertions to make a flaky test pass.

## Coverage

- `npm run coverage` enforces 95% statements, branches, functions, and lines for authored `src/**/*.ts`.
- Falling below 95% should trigger useful behavioral tests or a focused explanation of why the code should be excluded.
- `v8 ignore` is acceptable only for entrypoints, platform-specific branches, or defensive paths that cannot be exercised deterministically.
