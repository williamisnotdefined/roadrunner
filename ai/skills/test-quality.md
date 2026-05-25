# Test Quality

Use this skill when changing tests, test helpers, Vitest configuration, coverage thresholds, or verification strategy.

## Read First

- `ai/rules/testing-rules.md`
- `ai/rules/test-quality-rules.md`

## Workflow

- Start from the behavior or failure mode that must be protected.
- Prefer public APIs, CLI commands, files, logs, and queue state over private implementation details.
- Cover realistic success and failure paths before chasing uncovered lines.
- Keep tests deterministic with temporary directories and fake providers.
- Use coverage as a 95% guardrail; do not write branch-only tests for metric gaming.
- Keep `v8 ignore` rare and justified by entrypoint, platform, or nondeterministic process behavior.
