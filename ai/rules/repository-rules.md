# Repository Rules

## Always

- Keep Roadrunner provider-agnostic where possible.
- Keep OpenCode-specific behavior inside the provider adapter.
- Keep autonomous runs plan-first and verification-gated.
- Keep startup queue refresh and reconciliation as read-only queue proposal phases, not file-editing phases.
- Keep `GOALS.md` as a run-start in-memory snapshot during autonomous runs.
- Treat autonomous run queues as in-memory runtime state rebuilt at run start from roadmap and repository state.

## Never

- Do not kill arbitrary editor or agent processes.
- Do not skip failing verification.
- Do not create automatic Roadrunner commits.
