# Roadmap Loop

Roadrunner executes a queue of deliverable tasks. Each run starts by hard-resetting the operational queue from the roadmap and current repository state:

```txt
Startup Queue Refresh -> Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize
```

The queue lives in the configured runtime queue file, defaulting to `.roadrunner/state/queue.json` in the target project. It contains `version`, `model`, `variant`, `queue`, `history`, and `blocked`. The first queued item is the only current task during implementation attempts.

`GOALS.md` is loaded once at the start of a run and used as an immutable in-memory goal snapshot for all prompts in that run. The configured roadmap file is also read at run start. `.roadrunner/state/queue.json` is treated as a generated operational artifact for the current run, not as durable source of truth.

Startup queue refresh overwrites stale or missing queue state, seeds from operational roadmap Markdown when possible, and then asks the provider to audit the current repository state. It may move already satisfied roadmap work to `history`, keep relevant work in `queue`, put still-relevant blockers in `blocked`, and drop obsolete or superseded work. It may only mutate the configured queue file.

Roadmaps may still be imported manually from Markdown into the queue with `import-roadmap`, but autonomous `run` does not depend on pre-imported queue state.

After verification passes, Roadrunner marks the current step done before reconciliation. Reconciliation then optimizes open `queue` items by grouping microtasks, splitting oversized tasks, reordering dependencies, adding discovered future work, and removing obsolete work. It must preserve `version`, `model`, `variant`, `history`, and `blocked`, and it may only mutate the configured queue file.

Roadrunner does not require a clean git worktree, does not restore file changes, and does not create commits. Failures update the queue state by blocking the current step when possible.

Interactive `run` executions open a terminal dashboard with task navigation, log viewing, session debug logs, and a restart action for the current task. Restarting aborts the active Roadrunner-owned subprocess, cleans registered Roadrunner subprocesses, and retries the current `queue[0]` task from planning. Restarting a task does not reset project files, rewrite history, or skip verification. Once a verified task is marked done, post-step reconciliation cannot restart that completed task.

Provider and verification activity is watched for idle stalls. By default, a task attempt that produces no activity for ten minutes is aborted and restarted from planning. Automatic restarts are limited per step, defaulting to three, after which Roadrunner blocks the current task with a clear idle-restart reason. `ROADRUNNER_AUTO_RESTART_IDLE_MS` and `ROADRUNNER_MAX_AUTO_RESTARTS_PER_STEP` override the defaults; `0` disables the automatic restart path.
