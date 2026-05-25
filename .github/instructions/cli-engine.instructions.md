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

## Verification

- `npm run typecheck`
- `npm test`
- `npm run coverage`
- `npm run ai:check`

## E2E

- Keep deterministic e2e tests in the normal Vitest suite with fake providers.
- Keep real provider e2e tests behind explicit opt-in scripts such as `npm run e2e:real`.
- Write e2e target projects under `test-output/`.

## ai/architecture/project-architecture.md

# Project Architecture

Roadrunner is a CLI for autonomous software engineering loops.

Core modules:

- `src/cli.ts`: command dispatch.
- `src/init.ts`: target project bootstrap.
- `src/queue.ts`: queue validation and mutation.
- `src/roadmap.ts`: Markdown roadmap import into queue state.
- `src/runner.ts`: plan/execute/verify/reconcile flow with an in-memory goals snapshot.
- `src/process-registry.ts`: safe child-process tracking.
- `src/providers/opencode.ts`: OpenCode provider adapter.

## ai/architecture/roadmap-loop.md

# Roadmap Loop

Roadrunner executes a queue of small tasks. Each task follows:

```txt
Plan -> Execute -> Verify -> Reconcile
```

The queue lives in the configured queue file, defaulting to `.roadrunner/queue.json` in the target project. It contains `version`, `model`, `variant`, `queue`, `history`, and `blocked`. The first queued item is the only current task.

`GOALS.md` is loaded once at the start of a run and used as an immutable in-memory goal snapshot for all prompts in that run. `ROADMAP.md` is read only by `init` and `import-roadmap`; after import, the queue file is the live task state.

Roadmaps may be imported from Markdown into the queue. Import preserves existing `history` and `blocked` records and only queues steps that have not already been closed.

Roadrunner does not require a clean git worktree, does not restore file changes, and does not create commits. Failures update the queue state by blocking the current step when possible.
