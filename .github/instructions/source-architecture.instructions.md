---
applyTo: "src/**/*.ts,tests/**/*.ts,ai/**/*.md"
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
- Place new source files in the appropriate layer folder: `domain`, `application`, `infrastructure`, `infrastructure/providers`, `ui`, or `cli`.
- Extract pure helpers before process, filesystem, or provider code.
- Keep public behavior and queue semantics stable while refactoring.
- Split tests by behavior when source modules split.
- Run focused tests after each extraction, then the broader Node and AI checks before finishing.

# Referenced Context

## ai/rules/source-architecture-rules.md

# Source Architecture Rules

## Always

- Keep modules cohesive around one reason to change.
- Keep `src` organized by the DDD-style folders `domain`, `application`, `infrastructure`, `infrastructure/providers`, `ui`, and `cli`.
- Prefer extracting pure parsing, validation, formatting, and calculation before extracting side-effectful orchestration.
- Keep provider-specific behavior under `src/infrastructure/providers`.
- Keep queue state transitions and validation centralized in queue-focused modules.
- Keep process spawning, timeout handling, process-group signaling, and process registry writes behind infrastructure helpers.
- Use explicit ports or interfaces only when they protect a real boundary, such as providers or process execution.
- Treat 250 lines as the target production module size and 300 lines as the review threshold.
- Keep `npm run size:check` passing when adding or growing authored TypeScript files.
- Update or split tests along the same behavioral boundaries as source refactors.

## Never

- Do not let application orchestration modules accumulate provider, shell, git, filesystem traversal, prompt rendering, and queue mutation details together.
- Do not import provider adapters from domain modules.
- Do not put UI, CLI, process, filesystem, or provider orchestration in `src/domain`.
- Do not let provider adapters mutate queue state or own Roadrunner workflow decisions.
- Do not create abstractions solely to satisfy a pattern name such as DRY, SOLID, or DDD; split only around stable responsibilities.
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

Roadrunner source code should stay organized around clear responsibility boundaries and DDD-style layers.

## Folder Layers

- `src/domain/`: queue data, validation, parsing, restart policy, timeouts, and pure formatting. Domain modules should avoid process, provider, filesystem orchestration, UI, and CLI concerns.
- `src/application/`: use cases such as init, planning, running, task execution, verification, reconciliation, queue proposals, run snapshots, and restart coordination.
- `src/infrastructure/`: side effects such as project config loading, locks, managed shell processes, process registries, process trees, prompt/log artifacts, and provider adapters.
- `src/infrastructure/providers/`: provider port and provider-specific adapters. OpenCode-specific behavior stays here.
- `src/ui/`: interactive TUI state, view formatting, progress models, session logs, and log discovery.
- `src/cli/`: command dispatch, argument parsing, and CLI invocation validation.

## Dependency Direction

- Domain should not import application, infrastructure, UI, CLI, or providers unless a legacy mixed-responsibility module is being actively split.
- Application may import domain and infrastructure ports/adapters to coordinate use cases.
- Infrastructure may import domain types and policies but should not own queue workflow decisions.
- UI may import application APIs and domain presentation models but should not mutate queues or process registries directly.
- CLI may compose all layers for command dispatch only.

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

Core modules by layer:

- `src/cli/index.ts`: command dispatch and package bin entrypoint.
- `src/cli/args.ts`: CLI argument parsing.
- `src/cli/validation.ts`: CLI invocation validation.
- `src/domain/queue.ts`: queue validation and mutation.
- `src/domain/roadmap.ts`: Markdown roadmap parsing and queue seed creation.
- `src/domain/restart-policy.ts`: automatic restart defaults and environment overrides.
- `src/domain/timeouts.ts`: provider, verification, and OpenCode check timeout resolution.
- `src/domain/duration.ts`: shared duration formatting.
- `src/application/init.ts`: target project bootstrap.
- `src/application/runner.ts`: public runner facade and startup/plan/execute/verify/reconcile-optimize loop.
- `src/application/runner-control.ts`: run control for restart and cooperative stop requests.
- `src/application/runner-execution.ts`: task attempt orchestration, manual restarts, automatic idle restarts, and step completion.
- `src/application/runner-startup.ts`: run-start hard reset, roadmap/repository queue refresh, and startup queue proposal handling.
- `src/application/runner-planning.ts`: planning prompt execution.
- `src/application/runner-verification.ts`: verification commands and fix-failure provider calls.
- `src/application/runner-reconciliation.ts`: post-step read-only open-queue optimization and closed-record preservation.
- `src/application/auto-restart-watchdog.ts`: idle activity watchdog for automatic task-attempt restarts.
- `src/application/queue-proposal.ts`: provider queue proposal extraction and validation.
- `src/application/run-snapshot.ts`: run-start in-memory goals snapshot loading.
- `src/infrastructure/config.ts`: project config and path loading.
- `src/infrastructure/run-artifacts.ts`: private prompt/log artifact helpers.
- `src/infrastructure/managed-process.ts`: managed shell subprocess execution for verification.
- `src/infrastructure/process-registry.ts`: safe child-process tracking.
- `src/infrastructure/providers/index.ts`: provider factory and configured-provider validation.
- `src/infrastructure/providers/provider.ts`: provider port interfaces.
- `src/infrastructure/providers/opencode.ts`: OpenCode provider adapter.
- `src/ui/run-tui.ts`: TUI runner wrapper.
- `src/ui/run-tui-app.ts`: blessed full-screen TUI.
- `src/ui/run-tui-navigation.ts`: TUI focus navigation helpers.
- `src/ui/run-tui-view.ts`: TUI view text formatting.
