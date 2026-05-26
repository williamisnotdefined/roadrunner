# Source Architecture

Roadrunner source code should stay organized around clear responsibility boundaries and DDD-style layers.

## Folder Layers

- `src/domain/`: queue data, validation, parsing, restart policy, timeouts, and pure formatting. Domain modules should avoid process, provider, filesystem orchestration, UI, and CLI concerns.
- `src/application/`: use cases such as init, planning, running, task execution, verification, reconciliation, queue proposals, run snapshots, and restart coordination.
- `src/infrastructure/`: side effects such as project config loading, locks, managed shell processes, process registries, process trees, prompt/log artifacts, and provider adapters.
- `src/infrastructure/providers/`: provider port and provider-specific adapters. OpenCode-specific behavior stays here.
- `src/ui/`: interactive TUI state, view formatting, progress models, session logs, and log discovery.
- `src/cli/`: command dispatch, argument parsing, and CLI invocation validation.

## Dependency Direction

- Domain should not import application, infrastructure, UI, CLI, or providers unless a legacy mixed-responsibility module is being actively split.
- Application may import domain and infrastructure ports/adapters to coordinate use cases.
- Infrastructure may import domain types and policies but should not own queue workflow decisions.
- UI may import application APIs and domain presentation models but should not mutate queues or process registries directly.
- CLI may compose all layers for command dispatch only.

## Size Guardrails

- Production modules should target 250 lines or fewer.
- Files above 300 lines need a clear cohesion reason or a planned extraction.
- Files above 400 lines should not grow without first splitting responsibilities.
- Functions should target 60 lines or fewer; functions above 80 lines should be reviewed for extraction.
- Test files may be larger, but should target 350 lines or fewer before splitting by behavior.

These are review guardrails, not mechanical goals. Prefer small cohesive modules over arbitrary splitting.

`npm run size:check` enforces the current guardrails for authored TypeScript: production `src/**/*.ts` files are limited to 300 lines and `tests/**/*.ts` files are limited to 400 lines.
