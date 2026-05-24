# Provider Rules

## Always

- Keep provider-specific command construction inside `src/providers`.
- Default OpenCode to `openai/gpt-5.5` and variant `xhigh`.
- Sanitize prompts from process registries and logs where appropriate.

## Never

- Do not spread OpenCode flags throughout the runner.
- Do not make provider adapters own queue state transitions.
