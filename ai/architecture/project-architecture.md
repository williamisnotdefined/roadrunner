# Project Architecture

Roadrunner is a CLI for autonomous software engineering loops.

Core modules:

- `src/cli.ts`: command dispatch.
- `src/init.ts`: target project bootstrap.
- `src/queue.ts`: queue validation and mutation.
- `src/queue-service.ts`: application-level queue validation and blocking helpers.
- `src/roadmap.ts`: Markdown roadmap import into queue state.
- `src/runner.ts`: public runner facade and plan/execute/verify/reconcile-optimize loop.
- `src/runner-execution.ts`: task attempt orchestration, manual restarts, automatic idle restarts, and step completion.
- `src/runner-planning.ts`: planning prompt execution and read-only mutation checks.
- `src/runner-verification.ts`: verification commands and fix-failure provider calls.
- `src/runner-reconciliation.ts`: future-queue optimization, queue-only reconciliation enforcement, and closed-record preservation.
- `src/auto-restart-watchdog.ts`: idle activity watchdog for automatic task-attempt restarts.
- `src/restart-policy.ts`: automatic restart defaults and environment overrides.
- `src/run-snapshot.ts`: run-start in-memory goals snapshot loading.
- `src/run-artifacts.ts`: private prompt/log artifact helpers.
- `src/duration.ts`: shared duration formatting.
- `src/managed-process.ts`: managed shell subprocess execution for verification.
- `src/mutation-fingerprint.ts`: git/filesystem mutation fingerprints.
- `src/process-registry.ts`: safe child-process tracking.
- `src/providers/index.ts`: provider factory and configured-provider validation.
- `src/providers/provider.ts`: provider port interfaces.
- `src/providers/opencode.ts`: OpenCode provider adapter.
