# Roadmap Autopilot Rules

## Always

- Follow `Plan -> Execute -> Verify -> Commit -> Reconcile`.
- Treat `queue[0]` as the current task.
- Preserve `history` and `blocked` records.
- Stop on persistent blockers.

## Never

- Do not rewrite history during reconciliation.
- Do not bypass verification.
- Do not edit target `GOALS.md` during autonomous runs.
