# Roadrunner

Goal-directed autonomous software engineering loop.

Roadrunner turns project goals, a roadmap, and current repository state into a repeatable cycle:

```txt
Startup Queue Refresh -> Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize
```

It is designed to run coding agents over roadmap-derived steps, with explicit planning, verification, process cleanup, startup queue refresh, and queue reconciliation that can optimize future work.

## Commands

```bash
tsx src/cli/index.ts init --goals GOALS.md --roadmap ROADMAP.md
tsx src/cli/index.ts check
tsx src/cli/index.ts status
tsx src/cli/index.ts next
tsx src/cli/index.ts import-roadmap --roadmap ROADMAP.md
tsx src/cli/index.ts plan
tsx src/cli/index.ts run --max-steps 1
tsx src/cli/index.ts run --max-steps 999 --max-hours 72
tsx src/cli/index.ts cleanup
```

## Running Roadrunner On Another Project

Roadrunner always treats the current working directory as the target project. Run the CLI from the project you want it to modify, not from the Roadrunner repository.

If you run it from `~/git/rubiks-cube-solver`, Roadrunner reads and writes files in `~/git/rubiks-cube-solver` and stores its queue state under that project's `.roadrunner/` directory. Roadrunner does not require a clean git worktree and does not create its own commits; provider agents and verification commands still run in the target project and may execute git commands if your prompts, roadmap, or scripts ask them to.

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
node /home/wozzp/git/roadrunner/dist/src/cli/index.js init --goals GOALS.md --roadmap ROADMAP.md
```

`init` creates `.roadrunner/config.json`, `.roadrunner/state/queue.json`, `.roadrunner/prompts/`, and `.roadrunner/logs/`. If `ROADMAP.md` exists, it imports roadmap steps into the initial runtime queue; otherwise the queue starts empty. Autonomous `run` refreshes this queue again at every run start.

Validate and inspect the target project before running:

```bash
node /home/wozzp/git/roadrunner/dist/src/cli/index.js check
node /home/wozzp/git/roadrunner/dist/src/cli/index.js status
```

`check` validates `GOALS.md`, the configured runtime queue, and the configured provider CLI. `status` shows how many steps are queued, done, blocked, and which step is currently `queue[0]`.

Run one step first if you want a safe smoke test:

```bash
node /home/wozzp/git/roadrunner/dist/src/cli/index.js run --max-steps 1
```

Run the autonomous loop until the queue finishes or a limit/blocker is reached:

```bash
cd ~/git/rubiks-cube-solver
node /home/wozzp/git/roadrunner/dist/src/cli/index.js run --max-steps 999 --max-hours 72
```

At run start, `run` cleans registered Roadrunner-owned subprocesses, reads `GOALS.md`, reads the configured roadmap, ignores stale queue state, and refreshes `.roadrunner/state/queue.json` from roadmap plus current repository state. For each remaining queued step, `run` performs:

```txt
Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize
```

With `--max-steps 999 --max-hours 72`, Roadrunner will keep working until one of these happens:

- The queue is empty.
- 999 steps have completed.
- 72 hours have elapsed.
- A provider, verification, or reconciliation failure blocks the run.
- The current task stays idle past the automatic restart limit and is blocked.

`GOALS.md` is loaded once at the start of `run` and remains the in-memory goal for that execution. The configured roadmap is read at run start. `.roadrunner/state/queue.json` is generated live task state for the current run and is ignored as runtime data, so deleting it or leaving a stale queue behind does not require manual cleanup before the next `run`. `--goals` and `--roadmap` are resolved relative to the target project directory.

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
- `.roadrunner/state/queue.json` if missing.
- `.roadrunner/prompts/` with default prompts, without overwriting existing prompt files.
- `.roadrunner/logs/` for run logs.

If the configured roadmap path exists, defaulting to `ROADMAP.md` or set with `--roadmap path`, `init` parses it into the initial queue. Without a roadmap, the initial queue is valid but empty.

### `import-roadmap`

Parses a roadmap Markdown file into the configured queue file.

Existing `history` and `blocked` records are preserved. Imported steps whose IDs are already in `history` or `blocked` are not requeued. The open queue is replaced by the imported open roadmap steps, so open steps removed from `ROADMAP.md` are removed from the configured runtime queue on import.

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
Startup Queue Refresh -> Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize
```

The runner holds `.roadrunner/roadmap.lock` for the duration of the run to avoid concurrent Roadrunner commands mutating the same queue. `import-roadmap` also takes this lock before writing the configured runtime queue. Roadrunner does not block because of unrelated user edits, dirty git state, provider git commands, or verification commands that mutate files.

At run start, Roadrunner reads `GOALS.md` once and uses that immutable in-memory snapshot for startup refresh, planning, implementation, fixing, and reconciliation prompts. It also reads the configured roadmap and hard-resets `.roadrunner/state/queue.json` as a generated operational artifact. The startup refresh agent may mark already satisfied roadmap work as `history`, keep relevant pending work in `queue`, and remove obsolete or superseded work from the run queue. Edits to `GOALS.md` during a run only affect future runs.

After a step verifies successfully, Roadrunner moves it to `history` before running post-step reconciliation. If reconciliation fails, verified progress remains recorded instead of being blocked or retried as unfinished work.

Provider runs default to `ROADRUNNER_PROVIDER_TIMEOUT_MS=1800000`, verification commands default to `ROADRUNNER_VERIFY_TIMEOUT_MS=600000`, automatic idle restarts default to `ROADRUNNER_AUTO_RESTART_IDLE_MS=600000` and `ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP=3`, and OpenCode CLI validation defaults to `ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS=10000`. Set provider, verification, automatic restart idle, or max automatic restart variables to `0` to disable that timeout/restart path. `--max-hours` caps provider and verification timeouts for the current step.

`run` requires an interactive terminal and opens a full-screen task dashboard. The dashboard header shows the active execution state, such as `REFRESHING QUEUE`, `PLANNING`, `IMPLEMENTING`, `VERIFYING`, `FIXING`, or `RECONCILING`; details show elapsed/idle time, queue summary, PID, and active log. Done tasks are summarized instead of filling the table, and log entries use short labels with the active log promoted to the top. Use Up/Down to select tasks or logs, Tab/Shift+Tab to switch panels, Enter to open the selected log, `r` to restart the current `queue[0]` task from planning after confirmation, and `q`, `Ctrl+C`, or `Ctrl+Q` to stop the run and clean Roadrunner-owned subprocesses. Provider output is captured to log files instead of being streamed over the UI.

Each run also writes a debug session directory under `.roadrunner/logs/` with `session.log` for human-readable events and `events.ndjson` for machine-readable events. Roadrunner also auto-restarts idle task attempts from planning when no provider or verification activity arrives before the configured idle threshold. Restarting or stopping does not reset or revert project files; it only stops registered Roadrunner subprocesses and, for restarts, repeats the task attempt.

Prompt files, provider logs, verification logs, and runner-generated markdown outputs under `.roadrunner/logs/` are written with restrictive filesystem permissions.

Startup refresh, implementation, fix, and reconciliation provider runs use normal OpenCode permissions by default. Set `dangerouslySkipPermissions: true` in `.roadrunner/config.json` only when you intentionally want Roadrunner to pass OpenCode's `--dangerously-skip-permissions` flag.

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

Supported heading forms are `## step-id: Title`, `## step-id - Title`, and `## [step-id] Title`; heading levels `##` through `######` are accepted. Required fields are `Phase`, `Scope`, `Prompt`, `Acceptance`, and `Verification`. Unknown fields are ignored except inside multiline `Prompt`, where `Label:` lines remain part of the prompt until the next known field.

Autonomous `run` can also start from a more strategic roadmap that is not in this operational format. In that case startup refresh asks the provider to compile the roadmap and current repository state into a valid operational `.roadrunner/state/queue.json` before execution.

During development in this repo:

```bash
npm run ai:sync
npm run ai:check
npm run lint
npm run format
npm run typecheck
npm run size:check
npm test
npm run coverage
npm run smoke:pack
npm run check
```

`npm test` runs the Vitest unit/integration suite plus the deterministic fake-provider e2e. `npm run lint` runs Biome linting plus the AI route check. `npm run format` syncs AI routes and formats supported files with Biome. `npm run size:check` enforces file-size guardrails for authored TypeScript. `npm run coverage` enforces a 95% coverage guardrail for authored `src/**/*.ts`; behavior, failure modes, and regression value matter more than reaching a higher number. `npm run smoke:pack` verifies the package dry-run includes the built CLI, templates, README, and `roadrunner` bin. `npm run e2e:real` is opt-in through `scripts/e2e-real.ts` and runs OpenCode for real with `ROADRUNNER_E2E_REAL_OPENCODE=1`; run it before declaring compatibility with a real OpenCode version. The real e2e creates a unique target under `test-output/e2e-real/` and validates the generated Todo API through a black-box Node script.

For real-provider debugging, run `ROADRUNNER_OPENCODE_DEBUG=1 npm run e2e:real`. Roadrunner writes provider output to each `*.opencode.log` while the process is running. `npm run e2e:real` defaults `ROADRUNNER_PROVIDER_TIMEOUT_MS` to `300000`; override it to fail faster or allow longer provider runs.

E2E outputs are written under `test-output/`:

- `test-output/e2e/todo-crud` for the deterministic fake OpenCode e2e.
- `test-output/e2e-real/todo-crud` for the real OpenCode e2e.

## Project Files Created By `init`

```txt
GOALS.md
ROADMAP.md (read when present, not created)
.roadrunner/
  config.json
  state/
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
- The configured roadmap is read at run start; `.roadrunner/state/queue.json` is generated mutable live queue state.
- Startup refresh may only update the configured queue file and must not edit source files.
- `queue[0]` is the current implementation task after startup refresh selects pending work.
- Planning is mandatory before execution.
- Planning fails if the planning agent mutates project files; Roadrunner uses git status in git repositories and a filesystem fingerprint fallback elsewhere.
- Verified tasks are moved to `history` before reconciliation.
- The reconciler may optimize open `queue` work by grouping, splitting, reordering, adding, or removing tasks, but it must preserve `history`, `blocked`, and queue metadata.
- Reconciliation may only update the configured queue file, defaulting to `.roadrunner/state/queue.json`; other file changes are treated as Roadrunner safety violations.
- Idle provider or verification phases are automatically restarted from planning up to the configured per-step limit.
- Cleanup only targets subprocesses registered by Roadrunner itself.
- Cleanup fails closed when a registered process identity cannot be verified.
- Nested OpenCode is rejected by default.
- Concurrent `run` and `import-roadmap` queue writers are rejected by the configured lock file.
- Provider prompts are passed through prompt files, not process argv.
- Runtime prompt and log files are written with restrictive permissions.
- OpenCode permission bypass is disabled by default and requires `dangerouslySkipPermissions: true`.

## Provider

The first provider is OpenCode using:

```txt
model: openai/gpt-5.5
variant: xhigh
```

Install OpenCode separately and ensure `opencode run --help` supports `--model`, `--variant`, `--agent`, `--file`, and `--dangerously-skip-permissions`. `roadrunner check`, `plan`, and `run` validate this before launching provider work, with `ROADRUNNER_OPENCODE_CHECK_TIMEOUT_MS` bounding the validation command.
