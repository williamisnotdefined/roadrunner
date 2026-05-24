# Provider OpenCode

Use this skill when changing the OpenCode provider adapter, model/variant behavior, prompts, or nested OpenCode safety.

## Read First

- `ai/rules/provider-rules.md`
- `ai/rules/process-supervisor-rules.md`
- `ai/architecture/provider-system.md`
- `ai/architecture/process-supervision.md`

## Workflow

- Keep OpenCode invocation details inside the provider adapter.
- Preserve `openai/gpt-5.5` and `xhigh` defaults.
- Register provider subprocesses before relying on cleanup.
