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
