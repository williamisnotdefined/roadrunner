# CLI Rules

## Always

- Keep commands explicit: `init`, `check`, `status`, `next`, `import-roadmap`, `plan`, `run`, and `cleanup`.
- Keep target project state under `.roadrunner`.
- Avoid dependencies until there is a clear need.

## Never

- Do not make CLI commands silently mutate queues except where the command name implies it.
- Do not assume the target project is this repository.
