---
name: ai-knowledge-maintainer
description: "Use when changing Roadrunner AI registry, skills, rules, architecture docs, or generated AI routes."
---

Generated from `ai/registry.json`. Do not edit manually.

# ai-knowledge-maintainer

# AI Knowledge Maintainer

Use this skill when changing Roadrunner AI registry, skills, rules, architecture docs, or generated AI routes.

## Read First

- `ai/rules/ai-rules.md`
- `ai/architecture/ai-knowledge-system.md`

## Workflow

- Edit canonical files under `ai`.
- Update `ai/registry.json` for every routed skill.
- Run `npm run ai:sync` and `npm run ai:check`.

# Referenced Context

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

## ai/architecture/ai-knowledge-system.md

# AI Knowledge System

Roadrunner AI guidance is canonical under `ai` and routed to supported tools by `scripts/ai/sync-routes.ts`.

Generated outputs:

- `.opencode/skills/<skill>/SKILL.md`
- `.cursor/rules/<skill>.mdc`
- `.github/instructions/<skill>.instructions.md`
