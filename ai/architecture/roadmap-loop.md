# Roadmap Loop

Roadrunner executes a queue of deliverable tasks. Each run starts by hard-resetting the operational queue from the roadmap and current repository state:

```txt
Startup Queue Refresh -> Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize
```

The autonomous run queue lives in memory for one execution. It contains `version`, `model`, `variant`, `queue`, `history`, and `blocked`. The first queued item is the only current task during implementation attempts.

`GOALS.md` is loaded once at the start of a run and used as an immutable in-memory goal snapshot for all prompts in that run. The configured roadmap file is also read at run start. Roadrunner does not use a persisted queue file as autonomous run state.

Startup queue refresh seeds from operational roadmap Markdown when possible, and then asks the provider in read-only planning mode to audit the current repository state and return a full queue JSON proposal. It may move already satisfied roadmap work to `history`, keep relevant work in `queue`, put still-relevant blockers in `blocked`, and drop obsolete or superseded work. It must not edit files.

After verification passes, Roadrunner marks the current step done in memory before reconciliation. Reconciliation then asks the provider in read-only planning mode for a full queue JSON proposal that optimizes open `queue` items by grouping microtasks, splitting oversized tasks, reordering dependencies, adding discovered future work, and removing obsolete work. It must preserve `version`, `model`, `variant`, `history`, and `blocked`, and it must not edit files.

Startup refresh and reconciliation should keep or add a final integrated product validation task when completed roadmap work lacks concrete evidence that the full solution has passed an end-to-end gate after the latest changes. This final task should run the project's complete product gate across core libraries, adapters, UI, E2E flows, documentation or AI checks, and any completed optional research modules. It should fix issues discovered by the gate without adding unrelated roadmap features.

Roadrunner does not require a clean git worktree, does not inspect git status or `HEAD` for queue control, does not restore file changes, and does not create commits. Failures update the in-memory queue state by blocking the current step when possible.

Interactive `run` executions open a terminal dashboard with task navigation, log viewing, session debug logs, and a restart action for the current task. Restarting aborts the active Roadrunner-owned subprocess, cleans registered Roadrunner subprocesses, and retries the current `queue[0]` task from planning. Restarting a task does not reset project files, rewrite history, or skip verification. Once a verified task is marked done, post-step reconciliation cannot restart that completed task.

Provider and verification activity is watched for idle stalls. By default, a task attempt that produces no activity for ten minutes is aborted and restarted from planning. Automatic restarts are limited per step, defaulting to three, after which Roadrunner blocks the current task with a clear idle-restart reason. `ROADRUNNER_AUTO_RESTART_IDLE_MS` and `ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP` override the defaults; `0` disables the automatic restart path.
