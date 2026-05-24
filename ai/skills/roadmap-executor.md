# Roadmap Executor

Use this skill when changing Roadrunner autonomous roadmap execution, plan-execute-verify-commit-reconcile behavior, or execution queue semantics.

## Read First

- `ai/rules/roadmap-autopilot-rules.md`
- `ai/rules/process-supervisor-rules.md`
- `ai/architecture/roadmap-loop.md`
- `ai/architecture/process-supervision.md`

## Workflow

- Keep `queue[0]` as the only current task.
- Keep planning mandatory before implementation.
- Keep cleanup constrained to Roadrunner-owned subprocesses.
- Stop on blockers rather than bypassing checks.
