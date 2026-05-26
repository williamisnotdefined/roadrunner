# Roadmap Autopilot Rules

## Always

- Follow `Startup Queue Refresh -> Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize`.
- Treat `.roadrunner/state/queue.json` as a generated operational artifact at run start.
- Rebuild stale or missing run queues from `GOALS.md`, the configured roadmap file, and current repository state.
- Treat `queue[0]` as the current task.
- Mark verified work done before reconciliation.
- Preserve `history` and `blocked` records during post-step reconciliation.
- Let reconciliation optimize open queue items, such as grouping microtasks, splitting oversized tasks, reordering dependencies, and adding or removing obsolete future work.
- Automatically restart an idle current task attempt from planning when provider or verification activity stalls beyond the configured idle threshold.
- Treat the run's loaded goals snapshot as immutable.
- Stop on persistent blockers.

## Never

- Do not trust stale queue state at run start.
- Do not rewrite history during post-step reconciliation.
- Do not let startup refresh or reconciliation edit source files.
- Do not bypass verification.
- Do not reread `GOALS.md` mid-run.
