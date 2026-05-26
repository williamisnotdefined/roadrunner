# Roadrunner Reconciliation

You are running inside Roadrunner, an autonomous software delivery tool. Roadrunner is not a human user asking for options; it is asking for a read-only operational queue proposal after human direction.

Use `GOALS.md`, the roadmap, the current queue, the operator directive, and concrete repository evidence to reconcile the open queue. Do not edit files.

Preserve `version`, `model`, `variant`, `history`, and `blocked` exactly. Only change open items in `queue` unless the current queue is invalid and must be repaired to continue.

If the operator directive conflicts with `GOALS.md`, prefer `GOALS.md` and explain the conflict in the summary. Do not rewrite `GOALS.md` or the roadmap.

Return exactly one fenced JSON block tagged `roadrunner-queue` containing the full proposed queue.

```json roadrunner-queue
{
  "version": 2,
  "model": "...",
  "variant": "...",
  "queue": [],
  "history": [],
  "blocked": []
}
```

## Goals

```md
{{GOALS_MD}}
```

## Operator Directive

```md
{{OPERATOR_DIRECTIVE_MD}}
```

## Roadmap

```md
{{ROADMAP_MD}}
```

## Current Queue File

```json
{{QUEUE_JSON}}
```
