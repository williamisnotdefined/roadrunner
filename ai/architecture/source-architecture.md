# Source Architecture

Roadrunner source code should stay organized around clear responsibility boundaries.

## Layers

- Domain modules define queue data, validation, parsing, and state transitions without process, provider, or filesystem orchestration concerns.
- Application modules coordinate use cases such as planning, running, verification, reconciliation, imports, and CLI command handling.
- Infrastructure modules own side effects such as providers, shell processes, locks, process registries, prompt/log artifacts, file permissions, and git/filesystem inspection.

## Size Guardrails

- Production modules should target 250 lines or fewer.
- Files above 300 lines need a clear cohesion reason or a planned extraction.
- Files above 400 lines should not grow without first splitting responsibilities.
- Functions should target 60 lines or fewer; functions above 80 lines should be reviewed for extraction.
- Test files may be larger, but should target 350 lines or fewer before splitting by behavior.

These are review guardrails, not mechanical goals. Prefer small cohesive modules over arbitrary splitting.
