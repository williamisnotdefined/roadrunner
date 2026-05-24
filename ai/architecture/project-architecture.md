# Project Architecture

Roadrunner is a CLI for autonomous software engineering loops.

Core modules:

- `src/cli.mjs`: command dispatch.
- `src/init.mjs`: target project bootstrap.
- `src/execution.mjs`: queue validation and mutation.
- `src/runner.mjs`: plan/execute/verify flow.
- `src/process-registry.mjs`: safe child-process tracking.
- `src/providers/opencode.mjs`: OpenCode provider adapter.
