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
- Keep reconciliation mandatory and focused on optimizing future queue items, not source edits.
- Keep automatic idle restarts bounded and routed through Roadrunner-owned cleanup.
- Keep the run-start goals snapshot immutable.
- Keep cleanup constrained to Roadrunner-owned subprocesses.
- Stop on blockers rather than bypassing checks.

# Referenced Context

## ai/rules/roadmap-autopilot-rules.md

# Roadmap Autopilot Rules

## Always

- Follow `Plan -> Execute -> Verify -> Reconcile/Optimize`.
- Treat `queue[0]` as the current task.
- Preserve `history` and `blocked` records.
- Let reconciliation optimize only future queue items, such as grouping microtasks, splitting oversized tasks, reordering dependencies, and adding or removing obsolete future work.
- Automatically restart an idle current task attempt from planning when provider or verification activity stalls beyond the configured idle threshold.
- Treat the run's loaded goals snapshot as immutable.
- Stop on persistent blockers.

## Never

- Do not rewrite history during reconciliation.
- Do not let reconciliation edit source files or the current `queue[0]` item.
- Do not bypass verification.
- Do not reread `GOALS.md` mid-run.

## ai/rules/process-supervisor-rules.md

# Process Supervisor Rules

## Always

- Register only subprocesses created by Roadrunner.
- Check PID start-time before signaling a process.
- Treat unverifiable process identity as stale; do not signal by PID existence alone.
- Clean only registered Roadrunner-owned subprocesses.
- Prefer process groups for provider subprocesses.

## Never

- Do not use `pgrep opencode` as a cleanup mechanism.
- Do not kill editor sessions or external agent processes.

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

## ai/architecture/process-supervision.md

# Process Supervision

Roadrunner registers subprocesses it creates in `.roadrunner/processes.json` in the target project.

Cleanup only signals registered processes after checking PID start-time ticks to reduce PID-reuse risk. Records without verifiable process identity are treated as stale instead of being signaled by PID alone.

Provider, verification, interactive task-restart cancellation, and automatic idle restarts use the same Roadrunner-owned process supervision path. Restarts and timeouts must signal only registered subprocesses or their process groups, never arbitrary editor or agent processes.
