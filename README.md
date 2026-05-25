# Roadrunner

Goal-directed autonomous software engineering loop.

Roadrunner turns a project goal and a task queue into a repeatable cycle:

```txt
Plan -> Execute -> Verify -> Reconcile
```

It is designed to run coding agents over small roadmap steps, with explicit planning, verification, process cleanup, and queue reconciliation.

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

## Running Roadrunner On Another Project

Roadrunner always treats the current working directory as the target project. Run the CLI from the project you want it to modify, not from the Roadrunner repository.

If you run it from `~/git/rubiks-cube-solver`, Roadrunner reads and writes files in `~/git/rubiks-cube-solver` and stores its queue state under that project's `.roadrunner/` directory. Roadrunner does not require a clean git worktree and does not create commits.

Example: work on `~/git/rubiks-cube-solver` using this local Roadrunner checkout.

First, build the Roadrunner CLI once:

```bash
cd /home/wozzp/git/roadrunner
npm run build
```

Then move into the target project:

```bash
cd ~/git/rubiks-cube-solver
```

Initialize Roadrunner state in the target project:

```bash
cd ~/git/rubiks-cube-solver
node /home/wozzp/git/roadrunner/dist/src/cli.js init --goals GOALS.md --roadmap ROADMAP.md
```

`init` creates `.roadrunner/config.json`, `.roadrunner/queue.json`, `.roadrunner/prompts/`, and `.roadrunner/logs/`. If `ROADMAP.md` exists, it imports roadmap steps into `.roadrunner/queue.json`.

Validate and inspect the target project before running:

```bash
node /home/wozzp/git/roadrunner/dist/src/cli.js check
node /home/wozzp/git/roadrunner/dist/src/cli.js status
```

`check` validates `GOALS.md`, `.roadrunner/queue.json`, and the configured provider CLI. `status` shows how many steps are queued, done, blocked, and which step is currently `queue[0]`.

Run one step first if you want a safe smoke test:

```bash
node /home/wozzp/git/roadrunner/dist/src/cli.js run --max-steps 1
```

Run the autonomous loop until the queue finishes or a limit/blocker is reached:

```bash
cd ~/git/rubiks-cube-solver
node /home/wozzp/git/roadrunner/dist/src/cli.js run --max-steps 999 --max-hours 72
```

For each queued step, `run` performs:

```txt
Plan -> Execute -> Verify -> Reconcile
```

With `--max-steps 999 --max-hours 72`, Roadrunner will keep working until one of these happens:

- The queue is empty.
- 999 steps have completed.
- 72 hours have elapsed.
- A provider, verification, or reconciliation failure blocks the run.

`GOALS.md` is loaded once at the start of `run` and remains the in-memory goal for that execution. `ROADMAP.md` is read only by `init` and `import-roadmap`; after import, `.roadrunner/queue.json` is the live task state. `--goals` and `--roadmap` are resolved relative to the target project directory.

Run commands as separate shell commands, or join them with `&&`. Do not paste multiple `node ...` commands on one line without a separator.

If launching Roadrunner from inside an existing OpenCode session, enable nested OpenCode in the target project's `.roadrunner/config.json`:

```json
{
  "allowNestedOpenCode": true
}
```

OpenCode permission bypass is disabled by default. For fully unattended runs, only enable it for trusted projects, goals, roadmaps, and queues:

```json
{
  "dangerouslySkipPermissions": true
}
```

Roadrunner validates `.roadrunner/config.json` strictly. Boolean options must be JSON booleans, string options must be non-empty strings, and unknown config or path keys are rejected.

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

Validates that `GOALS.md` exists, is not empty, the configured queue file matches Roadrunner queue schema, and the configured provider CLI is available.

### `status`

Prints queued, done, and blocked counts, followed by the current `queue[0]` step.

### `next`

Prints only the current `queue[0]` step.

### `plan`

Validates the project, loads `GOALS.md` into memory for the planning prompt, runs the planning agent for the current step, and writes plan logs under `.roadrunner/logs/`. Planning is run without skipped permissions.

### `run`

Runs autonomous cycles up to `--max-steps` or `--max-hours`:

```txt
Plan -> Execute -> Verify -> Reconcile
```

The runner holds `.roadrunner/roadmap.lock` for the duration of the run to avoid concurrent Roadrunner runners mutating the same queue. It does not block because of unrelated user edits, dirty git state, provider git commands, or verification commands that mutate files.

At run start, Roadrunner reads `GOALS.md` once and uses that immutable in-memory snapshot for planning, implementation, fixing, and reconciliation prompts. Edits to `GOALS.md` during a run only affect future runs.

Provider runs default to `ROADRUNNER_PROVIDER_TIMEOUT_MS=1800000` and verification commands default to `ROADRUNNER_VERIFY_TIMEOUT_MS=600000`. Set either variable to `0` to disable that timeout. `--max-hours` caps provider and verification timeouts for the current step.

Prompt files, provider logs, verification logs, and runner-generated markdown outputs under `.roadrunner/logs/` are written with restrictive filesystem permissions.

Implementation, fix, and reconciliation provider runs use normal OpenCode permissions by default. Set `dangerouslySkipPermissions: true` in `.roadrunner/config.json` only when you intentionally want Roadrunner to pass OpenCode's `--dangerously-skip-permissions` flag.

### `cleanup`

Signals only subprocesses registered by Roadrunner in the configured process registry. It does not search for arbitrary editor or agent processes.

Cleanup only signals a registry record when Roadrunner can verify the recorded process identity. Records without verifiable start-time identity are treated as stale rather than signaled by PID alone.

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
```

Supported heading forms are `## step-id: Title`, `## step-id - Title`, and `## [step-id] Title`; heading levels `##` through `######` are accepted. Required fields are `Phase`, `Scope`, `Prompt`, `Acceptance`, and `Verification`. Unknown fields are ignored.

During development in this repo:

```bash
npm run ai:sync
npm run ai:check
npm run lint
npm run format
npm run typecheck
npm test
npm run coverage
npm run check
```

`npm test` runs the Vitest unit/integration suite plus the deterministic fake-provider e2e. `npm run lint` runs Biome linting plus the AI route check. `npm run format` syncs AI routes and formats supported files with Biome. `npm run coverage` enforces 100% coverage for authored `src/**/*.ts`. `npm run e2e:real` is opt-in through `scripts/e2e-real.ts` and runs OpenCode for real with `ROADRUNNER_E2E_REAL_OPENCODE=1`; it is intentionally excluded from `test`, `coverage`, and `check`.

For real-provider debugging, run `ROADRUNNER_OPENCODE_DEBUG=1 npm run e2e:real`. Roadrunner streams provider output to each `*.opencode.log` while the process is running and prints the provider PID plus log path when each OpenCode subprocess starts. `npm run e2e:real` defaults `ROADRUNNER_PROVIDER_TIMEOUT_MS` to `300000`; override it to fail faster or allow longer provider runs.

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

- `GOALS.md` is loaded once into memory at run start.
- `ROADMAP.md` is only an import source; `.roadrunner/queue.json` is the mutable live queue.
- `queue[0]` is always the current task.
- Planning is mandatory before execution.
- The reconciler updates the configured queue file, defaulting to `.roadrunner/queue.json`; other file changes are not treated as Roadrunner safety violations.
- Cleanup only targets subprocesses registered by Roadrunner itself.
- Cleanup fails closed when a registered process identity cannot be verified.
- Nested OpenCode is rejected by default.
- Concurrent `run` processes are rejected by the configured lock file.
- Provider prompts are passed through prompt files, not process argv.
- Runtime prompt and log files are written with restrictive permissions.
- OpenCode permission bypass is disabled by default and requires `dangerouslySkipPermissions: true`.

## Provider

The first provider is OpenCode using:

```txt
model: openai/gpt-5.5
variant: xhigh
```

Install OpenCode separately and ensure `opencode run --help` supports `--model`, `--variant`, `--agent`, `--file`, and `--dangerously-skip-permissions`. `roadrunner check`, `plan`, and `run` validate this before launching provider work.
