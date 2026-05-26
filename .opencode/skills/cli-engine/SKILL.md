---
name: cli-engine
description: "Use when changing Roadrunner CLI commands, queue logic, init templates, or project configuration."
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

- Keep commands explicit: `init`, `check`, `status`, `next`, `plan`, `run`, and `cleanup`.
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

## ai/architecture/roadmap-loop.md

# Roadmap Loop

Roadrunner executes a queue of deliverable tasks. Each run starts by hard-resetting the operational queue from the roadmap and current repository state:

```txt
Startup Queue Refresh -> Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize
```

The autonomous run queue lives in memory for one execution. It contains `version`, `model`, `variant`, `queue`, `history`, and `blocked`. The first queued item is the only current task during implementation attempts.

`GOALS.md` is loaded once at the start of a run and used as an immutable in-memory goal snapshot for all prompts in that run. The configured roadmap file is also read at run start. Roadrunner does not use a persisted queue file as autonomous run state.

Startup queue refresh seeds from operational roadmap Markdown when possible, and then asks the provider in read-only planning mode to audit the current repository state and return a full queue JSON proposal. It may move already satisfied roadmap work to `history`, keep relevant work in `queue`, put still-relevant blockers in `blocked`, and drop obsolete or superseded work. It must not edit files.

After verification passes, Roadrunner marks the current step done in memory before reconciliation. Reconciliation then asks the provider in read-only planning mode for a full queue JSON proposal that optimizes open `queue` items by grouping microtasks, splitting oversized tasks, reordering dependencies, adding discovered future work, and removing obsolete work. It must preserve `version`, `model`, `variant`, `history`, and `blocked`, and it must not edit files.

Startup refresh and reconciliation should keep or add a final integrated product validation task when completed roadmap work lacks durable repository evidence that the full solution has passed an end-to-end gate after the latest relevant changes. This final task should audit whether the existing product gate covers `GOALS.md` and the completed roadmap, add or update missing tests, scripts, or documentation when coverage is incomplete, and then run the complete product gate across core libraries, adapters, UI, E2E flows, documentation or AI checks, and any completed optional research modules. It should fix issues discovered by the gate without adding unrelated roadmap features. Its output should leave durable repository evidence, such as a validation report or documented product-gate command with latest results, so future startup refreshes can converge instead of repeatedly re-adding the same validation task.

Roadrunner does not require a clean git worktree, does not inspect git status or `HEAD` for queue control, does not restore file changes, and does not create commits. Failures update the in-memory queue state by blocking the current step when possible.

Interactive `run` executions open a terminal dashboard with task navigation, log viewing, session debug logs, and a restart action for the current task. Restarting aborts the active Roadrunner-owned subprocess, cleans registered Roadrunner subprocesses, and retries the current `queue[0]` task from planning. Restarting a task does not reset project files, rewrite history, or skip verification. Once a verified task is marked done, post-step reconciliation cannot restart that completed task.

Provider and verification activity is watched for idle stalls. By default, a task attempt that produces no activity for ten minutes is aborted and restarted from planning. Automatic restarts are limited per step, defaulting to three, after which Roadrunner blocks the current task with a clear idle-restart reason. `ROADRUNNER_AUTO_RESTART_IDLE_MS` and `ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP` override the defaults; `0` disables the automatic restart path.
