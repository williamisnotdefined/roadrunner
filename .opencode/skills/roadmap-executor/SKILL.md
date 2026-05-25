---
name: roadmap-executor
description: "Use when changing Roadrunner autonomous roadmap runs, plan-execute-verify-reconcile behavior, or queue semantics."
---

Generated from `ai/registry.json`. Do not edit manually.

# roadmap-executor

# Roadmap Executor

Use this skill when changing Roadrunner autonomous roadmap runs, plan-execute-verify-reconcile behavior, or queue semantics.

## Read First

- `ai/rules/roadmap-autopilot-rules.md`
- `ai/rules/process-supervisor-rules.md`
- `ai/architecture/roadmap-loop.md`
- `ai/architecture/process-supervision.md`

## Workflow

- Keep `queue[0]` as the only current task.
- Keep planning mandatory before implementation.
- Keep the run-start goals snapshot immutable.
- Keep cleanup constrained to Roadrunner-owned subprocesses.
- Stop on blockers rather than bypassing checks.

# Referenced Context

## ai/rules/roadmap-autopilot-rules.md

# Roadmap Autopilot Rules

## Always

- Follow `Plan -> Execute -> Verify -> Reconcile`.
- Treat `queue[0]` as the current task.
- Preserve `history` and `blocked` records.
- Treat the run's loaded goals snapshot as immutable.
- Stop on persistent blockers.

## Never

- Do not rewrite history during reconciliation.
- Do not bypass verification.
- Do not reread `GOALS.md` mid-run.

## ai/rules/process-supervisor-rules.md

# Process Supervisor Rules

## Always

- Register only subprocesses created by Roadrunner.
- Check PID start-time before signaling a process.
- Clean only registered Roadrunner-owned subprocesses.
- Prefer process groups for provider subprocesses.

## Never

- Do not use `pgrep opencode` as a cleanup mechanism.
- Do not kill editor sessions or external agent processes.

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

## ai/architecture/process-supervision.md

# Process Supervision

Roadrunner registers subprocesses it creates in `.roadrunner/processes.json` in the target project.

Cleanup only signals registered processes after checking PID start-time ticks to reduce PID-reuse risk.
