# Roadmap Loop

Roadrunner executes a queue of small tasks. Each task follows:

```txt
Plan -> Execute -> Verify -> Commit -> Reconcile
```

The queue lives in the configured queue file, defaulting to `.roadrunner/queue.json` in the target project. The first queued item is the only current task.

Roadmaps may be imported from Markdown into the queue. Import preserves existing `history` and `blocked` records and only queues steps that have not already been closed.
