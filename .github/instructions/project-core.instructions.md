---
applyTo: "**/*"
---

Generated from `ai/registry.json`. Do not edit manually.

# project-core

# Project Core

Use this skill for all Roadrunner repository work.

## Read First

- `ai/rules/repository-rules.md`
- `ai/rules/testing-rules.md`
- `ai/rules/ai-rules.md`
- `ai/architecture/project-architecture.md`
- `ai/architecture/ai-knowledge-system.md`

## Workflow

- Preserve plan-first autonomous execution.
- Keep process cleanup limited to Roadrunner-owned subprocesses.
- Run relevant Node and AI checks before finishing.

# Referenced Context

## ai/rules/repository-rules.md

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

## ai/rules/testing-rules.md

# Testing Rules

## Always

- Add Node tests for pure queue, config, parsing, and process-registry behavior.
- Test with temporary directories when commands create files.
- Keep tests deterministic and dependency-light.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run coverage`
- `npm run ai:check`

## E2E

- Keep deterministic e2e tests in the normal Vitest suite with fake providers.
- Keep real provider e2e tests behind explicit opt-in scripts such as `npm run e2e:real`.
- Write e2e target projects under `test-output/`.

## ai/rules/ai-rules.md

# AI Rules

## Always

- Edit canonical files under `ai` first.
- Register every skill in `ai/registry.json`.
- Run `npm run ai:sync` after canonical AI changes.
- Run `npm run ai:check` before finishing.

## Never

- Do not manually edit generated route files.
- Do not put reusable architecture in skills when it belongs under `ai/architecture`.

## ai/architecture/project-architecture.md

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

## ai/architecture/ai-knowledge-system.md

# AI Knowledge System

Roadrunner AI guidance is canonical under `ai` and routed to supported tools by `scripts/ai/sync-routes.ts`.

Canonical content lives in:

- `ai/skills/` for skill instructions.
- `ai/rules/` for reusable rules.
- `ai/architecture/` for reusable architecture notes.
- `ai/registry.json` for route declarations and tool-specific metadata.

Generated route files are integration artifacts for individual tools. They intentionally duplicate the canonical content so each tool receives a self-contained instruction file. Do not edit generated route files directly; edit `ai/**`, then run `npm run ai:sync`.

Generated outputs:

- `.opencode/skills/<skill>/SKILL.md`
- `.cursor/rules/<skill>.mdc`
- `.github/instructions/<skill>.instructions.md`
