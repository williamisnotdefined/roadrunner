# Repository Rules

## Always

- Keep Roadrunner provider-agnostic where possible.
- Keep OpenCode-specific behavior inside the provider adapter.
- Keep autonomous runs plan-first and verification-gated.
- Keep `GOALS.md` as a run-start in-memory snapshot during autonomous runs.
- Keep `.roadrunner/queue.json` as the live autonomous task state.

## Never

- Do not kill arbitrary editor or agent processes.
- Do not skip failing verification.
- Do not create automatic Roadrunner commits.
