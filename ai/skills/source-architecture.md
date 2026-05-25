# Source Architecture

Use this skill when changing Roadrunner source architecture, module boundaries, refactors, DRY/SOLID/DDD structure, or large `src/**/*.ts` files.

## Read First

- `ai/rules/source-architecture-rules.md`
- `ai/rules/testing-rules.md`
- `ai/architecture/source-architecture.md`
- `ai/architecture/project-architecture.md`

## Workflow

- Identify the responsibility boundary before moving code.
- Extract pure helpers before process, filesystem, or provider code.
- Keep public behavior and queue semantics stable while refactoring.
- Split tests by behavior when source modules split.
- Run focused tests after each extraction, then the broader Node and AI checks before finishing.
