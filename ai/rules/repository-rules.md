# Repository Rules

## Always

- Keep Roadrunner provider-agnostic where possible.
- Keep OpenCode-specific behavior inside the provider adapter.
- Keep autonomous runs plan-first and verification-gated.
- Keep commits small and step-scoped.
- Treat `GOALS.md` in target projects as read-only during autonomous runs.

## Never

- Do not kill arbitrary editor or agent processes.
- Do not skip failing verification.
- Do not let implementation agents commit, push, or mutate queue state directly.
