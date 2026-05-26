# Roadrunner Goals

Build a reusable CLI that runs a goal-directed autonomous software engineering loop over existing repositories.

The CLI must:

- initialize projects with `GOALS.md`, `.roadrunner/config.json`, prompts, and runtime logs;
- keep autonomous run queues in memory and rebuild them from goals, roadmap, and current repository state;
- run `Plan -> Execute -> Verify -> Reconcile/Optimize` cycles;
- use provider adapters, starting with OpenCode;
- default to `openai/gpt-5.5` and variant `xhigh` for OpenCode;
- keep subprocess cleanup limited to Roadrunner-owned children;
- load `GOALS.md` once per run as the immutable in-memory goal;
- keep every implementation step explicit and verified;
- preserve AI knowledge and generated skill routes for supported coding tools.
