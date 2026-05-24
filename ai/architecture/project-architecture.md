# Project Architecture

Roadrunner is a CLI for autonomous software engineering loops.

Core modules:

- `src/cli.ts`: command dispatch.
- `src/init.ts`: target project bootstrap.
- `src/queue.ts`: queue validation and mutation.
- `src/roadmap.ts`: Markdown roadmap import into queue state.
- `src/runner.ts`: plan/execute/verify flow.
- `src/process-registry.ts`: safe child-process tracking.
- `src/providers/opencode.ts`: OpenCode provider adapter.
