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
