# Roadrunner

Goal-directed autonomous software engineering loop.

Roadrunner turns a project goal and a task queue into a repeatable cycle:

```txt
Plan -> Execute -> Verify -> Commit -> Reconcile
```

It is designed to run coding agents safely over small roadmap steps, with explicit planning, verification, commits, process cleanup, and queue reconciliation.

## Commands

```bash
tsx src/cli.ts init
tsx src/cli.ts status
tsx src/cli.ts next
tsx src/cli.ts plan
tsx src/cli.ts run --max-steps 1
tsx src/cli.ts run --max-steps 999 --max-hours 72
tsx src/cli.ts cleanup
```

During development in this repo:

```bash
npm run ai:sync
npm run ai:check
npm run typecheck
npm test
npm run check
```

## Project Files Created By `init`

```txt
GOALS.md
.roadrunner/
  config.json
  queue.json
  prompts/
  logs/
```

## Safety Model

- `GOALS.md` is read-only product direction for autonomous runs.
- `.roadrunner/queue.json` is the mutable queue.
- `queue[0]` is always the current task.
- Planning is mandatory before execution.
- The reconciler may only edit the configured queue file, defaulting to `.roadrunner/queue.json`.
- Cleanup only targets subprocesses registered by Roadrunner itself.
- Nested OpenCode is rejected by default.

## Provider

The first provider is OpenCode using:

```txt
model: openai/gpt-5.5
variant: xhigh
```
