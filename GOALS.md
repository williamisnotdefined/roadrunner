# Roadrunner Goals

Build a reusable CLI that runs a goal-directed autonomous software engineering loop over existing repositories.

The CLI must:

- initialize projects with `GOALS.md` and `.roadrunner/execution.json`;
- run `Plan -> Execute -> Verify -> Commit -> Reconcile` cycles;
- use provider adapters, starting with OpenCode;
- default to `openai/gpt-5.5` and variant `xhigh` for OpenCode;
- keep subprocess cleanup limited to Roadrunner-owned children;
- keep `GOALS.md` read-only during autonomous runs;
- keep every implementation step explicit, verified, and commit-sized;
- preserve AI knowledge and generated skill routes for supported coding tools.
