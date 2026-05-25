---
name: source-architecture
description: "Use when changing Roadrunner source architecture, module boundaries, refactors, DRY/SOLID/DDD structure, or large src/**/*.ts files."
---

Generated from `ai/registry.json`. Do not edit manually.

# source-architecture

# Source Architecture

Use this skill when changing Roadrunner source architecture, module boundaries, refactors, DRY/SOLID/DDD structure, or large `src/**/*.ts` files.

## Read First

- `ai/rules/source-architecture-rules.md`
- `ai/rules/testing-rules.md`
- `ai/architecture/source-architecture.md`
- `ai/architecture/project-architecture.md`

## Workflow

- Identify the responsibility boundary before moving code.
- Extract pure helpers before process, filesystem, or provider code.
- Keep public behavior and queue semantics stable while refactoring.
- Split tests by behavior when source modules split.
- Run focused tests after each extraction, then the broader Node and AI checks before finishing.

# Referenced Context

## ai/rules/source-architecture-rules.md

# Source Architecture Rules

## Always

- Keep modules cohesive around one reason to change.
- Prefer extracting pure parsing, validation, formatting, and calculation before extracting side-effectful orchestration.
- Keep provider-specific behavior under `src/providers`.
- Keep queue state transitions and validation centralized in queue-focused modules.
- Keep process spawning, timeout handling, process-group signaling, and process registry writes behind infrastructure helpers.
- Use explicit ports or interfaces only when they protect a real boundary, such as providers or process execution.
- Treat 250 lines as the target production module size and 300 lines as the review threshold.
- Keep `npm run size:check` passing when adding or growing authored TypeScript files.
- Update or split tests along the same behavioral boundaries as source refactors.

## Never

- Do not let application orchestration modules accumulate provider, shell, git, filesystem traversal, prompt rendering, and queue mutation details together.
- Do not import provider adapters from domain modules.
- Do not let provider adapters mutate queue state or own Roadrunner workflow decisions.
- Do not create abstractions solely to satisfy a pattern name such as DRY, SOLID, or DDD.
- Do not split code into tiny modules when the resulting boundary has no stable responsibility.

## ai/rules/testing-rules.md

# Testing Rules

## Always

- Add Node tests for pure queue, config, parsing, and process-registry behavior.
- Test with temporary directories when commands create files.
- Keep tests deterministic and dependency-light.
- Prioritize behavior, failure modes, and regression value over coverage percentage.
- Keep coverage thresholds at 95% as a guardrail.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run coverage`
- `npm run ai:check`

## E2E

- Keep deterministic e2e tests in the normal Vitest suite with fake providers.
- Keep real provider e2e tests behind explicit opt-in scripts such as `npm run e2e:real`.
- Write e2e target projects under `test-output/`.

## Coverage

- Use `v8 ignore` only for entrypoints, platform-specific branches, or nondeterministic defensive process paths.
- Do not add tests solely to satisfy a coverage metric.

## ai/architecture/source-architecture.md

# Source Architecture

Roadrunner source code should stay organized around clear responsibility boundaries.

## Layers

- Domain modules define queue data, validation, parsing, and state transitions without process, provider, or filesystem orchestration concerns.
- Application modules coordinate use cases such as planning, running, verification, reconciliation, imports, and CLI command handling.
- Infrastructure modules own side effects such as providers, shell processes, locks, process registries, prompt/log artifacts, file permissions, and git/filesystem inspection.

## Size Guardrails

- Production modules should target 250 lines or fewer.
- Files above 300 lines need a clear cohesion reason or a planned extraction.
- Files above 400 lines should not grow without first splitting responsibilities.
- Functions should target 60 lines or fewer; functions above 80 lines should be reviewed for extraction.
- Test files may be larger, but should target 350 lines or fewer before splitting by behavior.

These are review guardrails, not mechanical goals. Prefer small cohesive modules over arbitrary splitting.

`npm run size:check` enforces the current guardrails for authored TypeScript: production `src/**/*.ts` files are limited to 300 lines and `tests/**/*.ts` files are limited to 400 lines.

## ai/architecture/project-architecture.md

# Project Architecture

Roadrunner is a CLI for autonomous software engineering loops.

Core modules:

- `src/cli.ts`: command dispatch.
- `src/init.ts`: target project bootstrap.
- `src/queue.ts`: queue validation and mutation.
- `src/queue-service.ts`: application-level queue validation and blocking helpers.
- `src/roadmap.ts`: Markdown roadmap import into queue state.
- `src/runner.ts`: public runner facade and plan/execute/verify/reconcile-optimize loop.
- `src/runner-execution.ts`: task attempt orchestration, manual restarts, automatic idle restarts, and step completion.
- `src/runner-planning.ts`: planning prompt execution and read-only mutation checks.
- `src/runner-verification.ts`: verification commands and fix-failure provider calls.
- `src/runner-reconciliation.ts`: future-queue optimization, queue-only reconciliation enforcement, and closed-record preservation.
- `src/auto-restart-watchdog.ts`: idle activity watchdog for automatic task-attempt restarts.
- `src/restart-policy.ts`: automatic restart defaults and environment overrides.
- `src/run-snapshot.ts`: run-start in-memory goals snapshot loading.
- `src/run-artifacts.ts`: private prompt/log artifact helpers.
- `src/duration.ts`: shared duration formatting.
- `src/managed-process.ts`: managed shell subprocess execution for verification.
- `src/mutation-fingerprint.ts`: git/filesystem mutation fingerprints.
- `src/process-registry.ts`: safe child-process tracking.
- `src/providers/index.ts`: provider factory and configured-provider validation.
- `src/providers/provider.ts`: provider port interfaces.
- `src/providers/opencode.ts`: OpenCode provider adapter.
