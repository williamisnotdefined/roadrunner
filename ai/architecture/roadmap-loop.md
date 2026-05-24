# Roadmap Loop

Roadrunner executes a queue of small tasks. Each task follows:

```txt
Plan -> Execute -> Verify -> Commit -> Reconcile
```

The queue lives in `.roadrunner/execution.json` in the target project. The first queued item is the only current task.
