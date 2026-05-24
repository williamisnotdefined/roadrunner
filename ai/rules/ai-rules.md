# AI Rules

## Always

- Edit canonical files under `ai` first.
- Register every skill in `ai/registry.json`.
- Run `npm run ai:sync` after canonical AI changes.
- Run `npm run ai:check` before finishing.

## Never

- Do not manually edit generated route files.
- Do not put reusable architecture in skills when it belongs under `ai/architecture`.
