# Repository Rules

## Always

- Keep Roadrunner provider-agnostic where possible.
- Keep OpenCode-specific behavior inside the provider adapter.
- Keep autonomous runs plan-first and verification-gated.
- Keep startup queue refresh and reconciliation as queue-only phases, not source-editing phases.
- Keep `GOALS.md` as a run-start in-memory snapshot during autonomous runs.
- Treat `.roadrunner/state/queue.json` as generated runtime task state that is rebuilt at run start from roadmap and repository state.

## Never

- Do not kill arbitrary editor or agent processes.
- Do not skip failing verification.
- Do not create automatic Roadrunner commits.
