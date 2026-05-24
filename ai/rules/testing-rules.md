# Testing Rules

## Always

- Add Node tests for pure queue, config, parsing, and process-registry behavior.
- Test with temporary directories when commands create files.
- Keep tests deterministic and dependency-light.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run ai:check`
