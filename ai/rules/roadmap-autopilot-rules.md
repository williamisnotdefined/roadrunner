# Roadmap Autopilot Rules

## Always

- Follow `Startup Queue Refresh -> Plan -> Execute -> Verify -> Mark Done -> Reconcile/Optimize`.
- Keep autonomous run queues in memory for the current execution.
- Rebuild every run queue from `GOALS.md`, the configured roadmap file, and current repository state.
- Treat `queue[0]` as the current task.
- Mark verified work done before reconciliation.
- Preserve `history` and `blocked` records during post-step reconciliation.
- Let reconciliation optimize open queue items, such as grouping microtasks, splitting oversized tasks, reordering dependencies, and adding or removing obsolete future work.
- Keep or add a final integrated product validation queue item when completed roadmap work lacks durable repository evidence that the full solution passes an end-to-end gate after the latest relevant changes.
- Require final integrated validation work to audit gate coverage against `GOALS.md` and the completed roadmap, then add or update missing tests, scripts, or documentation before declaring success.
- Automatically restart an idle current task attempt from planning when provider or verification activity stalls beyond the configured idle threshold.
- Treat the run's loaded goals snapshot as immutable.
- Stop on persistent blockers.

## Never

- Do not trust stale queue state at run start.
- Do not rewrite history during post-step reconciliation.
- Do not let startup refresh or reconciliation edit files; they must return queue JSON proposals only.
- Do not bypass verification.
- Do not treat a roadmap as complete solely because individual tasks passed if the whole product has not been validated together.
- Do not rely on ephemeral run memory as proof that integrated validation passed across future runs.
- Do not reread `GOALS.md` mid-run.
