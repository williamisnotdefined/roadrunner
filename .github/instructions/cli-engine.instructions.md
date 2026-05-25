---
applyTo: "src/**/*.ts,templates/**/*,package.json"
---

Generated from `ai/registry.json`. Do not edit manually.

# cli-engine

# CLI Engine

Use this skill when changing Roadrunner CLI commands, queue logic, init templates, or project configuration.

## Read First

- `ai/rules/cli-rules.md`
- `ai/rules/testing-rules.md`
- `ai/architecture/project-architecture.md`
- `ai/architecture/roadmap-loop.md`

## Workflow

- Keep commands explicit and predictable.
- Test file-creating commands in temporary directories.
- Avoid dependencies until there is a concrete need.

# Referenced Context

## ai/rules/cli-rules.md

# CLI Rules

## Always

- Keep commands explicit: `init`, `check`, `status`, `next`, `import-roadmap`, `plan`, `run`, and `cleanup`.
- Keep target project state under `.roadrunner`.
- Avoid dependencies until there is a clear need.

## Never

- Do not make CLI commands silently mutate queues except where the command name implies it.
- Do not assume the target project is this repository.

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

## ai/architecture/roadmap-loop.md

# Roadmap Loop

Roadrunner executes a queue of deliverable tasks. Each task follows:

```txt
Plan -> Execute -> Verify -> Reconcile/Optimize
```

The queue lives in the configured queue file, defaulting to `.roadrunner/queue.json` in the target project. It contains `version`, `model`, `variant`, `queue`, `history`, and `blocked`. The first queued item is the only current task.

`GOALS.md` is loaded once at the start of a run and used as an immutable in-memory goal snapshot for all prompts in that run. `ROADMAP.md` is read only by `init` and `import-roadmap`; after import, the queue file is the live task state.

Roadmaps may be imported from Markdown into the queue. Import preserves existing `history` and `blocked` records and only queues steps that have not already been closed.

Reconciliation always runs after a verified step. It may optimize future `queue[1..]` items by grouping microtasks, splitting oversized tasks, reordering dependencies, adding discovered future work, and removing obsolete work. It must preserve `version`, `model`, `variant`, `history`, `blocked`, and the current `queue[0]` item exactly, and it may only mutate the configured queue file.

Roadrunner does not require a clean git worktree, does not restore file changes, and does not create commits. Failures update the queue state by blocking the current step when possible.

Interactive runs may accept a `rstask` control command. It aborts the active Roadrunner-owned subprocess, cleans registered Roadrunner subprocesses, and retries the current `queue[0]` task from planning. Restarting a task does not reset project files, rewrite history, or skip verification.

Provider and verification activity is watched for idle stalls. By default, a task attempt that produces no activity for ten minutes is aborted and restarted from planning. Automatic restarts are limited per step, defaulting to three, after which Roadrunner blocks the current task with a clear idle-restart reason. `ROADRUNNER_AUTO_RESTART_IDLE_MS` and `ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP` override the defaults; `0` disables the automatic restart path.
