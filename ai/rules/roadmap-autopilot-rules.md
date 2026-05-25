# Roadmap Autopilot Rules

## Always

- Follow `Plan -> Execute -> Verify -> Reconcile/Optimize`.
- Treat `queue[0]` as the current task.
- Preserve `history` and `blocked` records.
- Let reconciliation optimize only future queue items, such as grouping microtasks, splitting oversized tasks, reordering dependencies, and adding or removing obsolete future work.
- Automatically restart an idle current task attempt from planning when provider or verification activity stalls beyond the configured idle threshold.
- Treat the run's loaded goals snapshot as immutable.
- Stop on persistent blockers.

## Never

- Do not rewrite history during reconciliation.
- Do not let reconciliation edit source files or the current `queue[0]` item.
- Do not bypass verification.
- Do not reread `GOALS.md` mid-run.
