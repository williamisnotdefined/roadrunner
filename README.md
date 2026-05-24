# Roadrunner

Goal-directed autonomous software engineering loop.

Roadrunner turns a project goal and an execution queue into a repeatable cycle:

```txt
Plan -> Execute -> Verify -> Commit -> Reconcile
```

It is designed to run coding agents safely over small roadmap steps, with explicit planning, verification, commits, process cleanup, and queue reconciliation.

## Commands

```bash
node src/cli.mjs init
node src/cli.mjs status
node src/cli.mjs next
node src/cli.mjs plan
node src/cli.mjs run --max-steps 1
node src/cli.mjs run --max-steps 999 --max-hours 72
node src/cli.mjs cleanup
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
  execution.json
  prompts/
  logs/
```

## Safety Model

- `GOALS.md` is read-only product direction for autonomous runs.
- `.roadrunner/execution.json` is the mutable queue.
- `queue[0]` is always the current task.
- Planning is mandatory before execution.
- The reconciler may only edit `.roadrunner/execution.json`.
- Cleanup only targets subprocesses registered by Roadrunner itself.
- Nested OpenCode is rejected by default.

## Provider

The first provider is OpenCode using:

```txt
model: openai/gpt-5.5
variant: xhigh
```
