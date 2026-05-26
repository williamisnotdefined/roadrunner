# Provider Rules

## Always

- Keep provider-specific command construction inside `src/providers`.
- Default OpenCode to `openai/gpt-5.5` and variant `xhigh`.
- Require every provider run to declare `workspaceAccess` as `read-only` or `write`.
- Keep `dangerouslySkipPermissions` limited to write-capable implementation and fix runs.
- Sanitize prompts from process registries and logs where appropriate.

## Never

- Do not spread OpenCode flags throughout the runner.
- Do not make provider adapters own queue state transitions.
- Do not allow read-only provider runs to bypass provider permissions.
