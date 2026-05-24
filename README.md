# Roadrunner

Goal-directed autonomous software engineering loop.

Roadrunner turns a project goal and a task queue into a repeatable cycle:

```txt
Plan -> Execute -> Verify -> Commit -> Reconcile
```

It is designed to run coding agents safely over small roadmap steps, with explicit planning, verification, commits, process cleanup, and queue reconciliation.

## Commands

```bash
tsx src/cli.ts init --goals GOALS.md --roadmap ROADMAP.md
tsx src/cli.ts check
tsx src/cli.ts status
tsx src/cli.ts next
tsx src/cli.ts import-roadmap --roadmap ROADMAP.md
tsx src/cli.ts plan
tsx src/cli.ts run --max-steps 1
tsx src/cli.ts run --max-steps 999 --max-hours 72
tsx src/cli.ts cleanup
```

### `init`

Creates Roadrunner state for the current project.

By default it creates:

- `GOALS.md` if missing.
- `.roadrunner/config.json` if missing.
- `.roadrunner/queue.json` if missing.
- `.roadrunner/prompts/` with default prompts, without overwriting existing prompt files.
- `.roadrunner/logs/` for run logs.

If the configured roadmap path exists, defaulting to `ROADMAP.md` or set with `--roadmap path`, `init` parses it into the initial queue instead of copying the placeholder queue template.

### `import-roadmap`

Parses a roadmap Markdown file into the configured queue file.

Existing `history` and `blocked` records are preserved. Imported steps whose IDs are already in `history` or `blocked` are not requeued.

### `check`

Validates that `GOALS.md` exists, is not empty, and the configured queue file matches Roadrunner queue schema.

### `status`

Prints queued, done, and blocked counts, followed by the current `queue[0]` step.

### `next`

Prints only the current `queue[0]` step.

### `plan`

Runs the planning agent for the current step and writes plan logs under `.roadrunner/logs/`. Planning is run without skipped permissions.

### `run`

Runs autonomous cycles up to `--max-steps` or `--max-hours`:

```txt
Plan -> Execute -> Verify -> Commit -> Reconcile
```

The runner requires a clean git worktree before starting. Runtime files such as logs, process registries, and locks are excluded from Roadrunner's internal cleanliness checks.

### `cleanup`

Signals only subprocesses registered by Roadrunner in the configured process registry. It does not search for arbitrary editor or agent processes.

## Roadmap Format

Roadrunner parses deterministic Markdown step sections. Each step heading must include a kebab-case ID and title:

```md
## first-step: Add first feature

Phase: Bootstrap
Scope:
- README.md
- src/feature.ts

Prompt: Implement the first feature with the smallest correct change.

Acceptance:
- the feature is documented
- the behavior is covered by tests

Verification:
- npm run check

Commit: Add first feature
```

Supported heading forms are `## step-id: Title`, `## step-id - Title`, and `## [step-id] Title`. Supported fields are `Phase`, `Scope`, `Prompt`, `Acceptance`, `Verification`, `Commit`, and `Commit Message`.

During development in this repo:

```bash
npm run ai:sync
npm run ai:check
npm run typecheck
npm test
npm run coverage
npm run check
```

`npm test` runs the Vitest unit/integration suite plus the deterministic fake-provider e2e. `npm run coverage` enforces 100% coverage for authored `src/**/*.ts`. `npm run e2e:real` is opt-in and runs OpenCode for real with `ROADRUNNER_E2E_REAL_OPENCODE=1`; it is intentionally excluded from `test`, `coverage`, and `check`.

E2E outputs are written under `test-output/`:

- `test-output/e2e/todo-crud` for the deterministic fake OpenCode e2e.
- `test-output/e2e-real/todo-crud` for the real OpenCode e2e.

## Project Files Created By `init`

```txt
GOALS.md
ROADMAP.md (read when present, not created)
.roadrunner/
  config.json
  queue.json
  .gitignore
  prompts/
  logs/
```

## AI Knowledge System

Roadrunner keeps AI guidance centralized under `ai/`:

- `ai/skills/` contains canonical skill instructions.
- `ai/rules/` contains reusable rules.
- `ai/architecture/` contains reusable architecture notes.
- `ai/registry.json` declares which canonical content is routed to each tool.

The `.opencode/skills/`, `.cursor/rules/`, and `.github/instructions/` files are generated route outputs. They duplicate canonical content so each tool can consume a self-contained file, but they are not the source of truth.

After changing `ai/**`, run:

```bash
npm run ai:sync
npm run ai:check
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
