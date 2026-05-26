# Project Architecture

Roadrunner is a CLI for autonomous software engineering loops.

Core modules by layer:

- `src/cli/index.ts`: command dispatch and package bin entrypoint.
- `src/cli/args.ts`: CLI argument parsing.
- `src/cli/validation.ts`: CLI invocation validation.
- `src/domain/queue.ts`: queue validation and mutation.
- `src/domain/roadmap.ts`: Markdown roadmap parsing and queue seed creation.
- `src/domain/restart-policy.ts`: automatic restart defaults and environment overrides.
- `src/domain/timeouts.ts`: provider, verification, and OpenCode check timeout resolution.
- `src/domain/duration.ts`: shared duration formatting.
- `src/application/init.ts`: target project bootstrap.
- `src/application/runner.ts`: public runner facade and startup/plan/execute/verify/reconcile-optimize loop.
- `src/application/runner-control.ts`: run control for restart and cooperative stop requests.
- `src/application/runner-execution.ts`: task attempt orchestration, manual restarts, automatic idle restarts, and step completion.
- `src/application/runner-startup.ts`: run-start hard reset, roadmap/repository queue refresh, and startup queue proposal handling.
- `src/application/runner-planning.ts`: planning prompt execution.
- `src/application/runner-verification.ts`: verification commands and fix-failure provider calls.
- `src/application/runner-reconciliation.ts`: post-step read-only open-queue optimization and closed-record preservation.
- `src/application/auto-restart-watchdog.ts`: idle activity watchdog for automatic task-attempt restarts.
- `src/application/queue-proposal.ts`: provider queue proposal extraction and validation.
- `src/application/run-snapshot.ts`: run-start in-memory goals snapshot loading.
- `src/infrastructure/config.ts`: project config and path loading.
- `src/infrastructure/run-artifacts.ts`: private prompt/log artifact helpers.
- `src/infrastructure/managed-process.ts`: managed shell subprocess execution for verification.
- `src/infrastructure/process-registry.ts`: safe child-process tracking.
- `src/infrastructure/providers/index.ts`: provider factory and configured-provider validation.
- `src/infrastructure/providers/provider.ts`: provider port interfaces.
- `src/infrastructure/providers/opencode.ts`: OpenCode provider adapter.
- `src/ui/run-tui.ts`: TUI runner wrapper.
- `src/ui/run-tui-app.ts`: blessed full-screen TUI.
- `src/ui/run-tui-navigation.ts`: TUI focus navigation helpers.
- `src/ui/run-tui-view.ts`: TUI view text formatting.
