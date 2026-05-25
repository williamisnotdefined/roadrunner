# Roadrunner Reconcile Queue

Review project state and update the configured Roadrunner queue file if future queue changes are needed.

Preserve `history` and `blocked` exactly.

Do not move, remove, complete, block, or edit `queue[0]`. Roadrunner owns completion of the current step after reconciliation succeeds. Only change future `queue` items after `queue[0]` when needed.

## Goals

```md
{{GOALS_MD}}
```

## Queue

```json
{{QUEUE_JSON}}
```
