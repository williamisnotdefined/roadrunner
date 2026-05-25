# Roadmap Loop

Roadrunner executes a queue of small tasks. Each task follows:

```txt
Plan -> Execute -> Verify -> Reconcile
```

The queue lives in the configured queue file, defaulting to `.roadrunner/queue.json` in the target project. It contains `version`, `model`, `variant`, `queue`, `history`, and `blocked`. The first queued item is the only current task.

`GOALS.md` is loaded once at the start of a run and used as an immutable in-memory goal snapshot for all prompts in that run. `ROADMAP.md` is read only by `init` and `import-roadmap`; after import, the queue file is the live task state.

Roadmaps may be imported from Markdown into the queue. Import preserves existing `history` and `blocked` records and only queues steps that have not already been closed.

Roadrunner does not require a clean git worktree, does not restore file changes, and does not create commits. Failures update the queue state by blocking the current step when possible.

Interactive runs may accept a `rstask` control command. It aborts the active Roadrunner-owned subprocess, cleans registered Roadrunner subprocesses, and retries the current `queue[0]` task from planning. Restarting a task does not reset project files, rewrite history, or skip verification.
