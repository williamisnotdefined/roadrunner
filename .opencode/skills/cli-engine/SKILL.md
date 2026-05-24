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

## Verification

- `npm run typecheck`
- `npm test`
- `npm run ai:check`

## ai/architecture/project-architecture.md

# Project Architecture

Roadrunner is a CLI for autonomous software engineering loops.

Core modules:

- `src/cli.ts`: command dispatch.
- `src/init.ts`: target project bootstrap.
- `src/queue.ts`: queue validation and mutation.
- `src/runner.ts`: plan/execute/verify flow.
- `src/process-registry.ts`: safe child-process tracking.
- `src/providers/opencode.ts`: OpenCode provider adapter.

## ai/architecture/roadmap-loop.md

# Roadmap Loop

Roadrunner executes a queue of small tasks. Each task follows:

```txt
Plan -> Execute -> Verify -> Commit -> Reconcile
```

The queue lives in the configured queue file, defaulting to `.roadrunner/queue.json` in the target project. The first queued item is the only current task.
