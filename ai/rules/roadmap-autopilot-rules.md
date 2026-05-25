# Roadmap Autopilot Rules

## Always

- Follow `Plan -> Execute -> Verify -> Reconcile`.
- Treat `queue[0]` as the current task.
- Preserve `history` and `blocked` records.
- Treat the run's loaded goals snapshot as immutable.
- Stop on persistent blockers.

## Never

- Do not rewrite history during reconciliation.
- Do not bypass verification.
- Do not reread `GOALS.md` mid-run.
