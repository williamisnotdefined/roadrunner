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
