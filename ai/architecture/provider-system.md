# Provider System

Providers turn Roadrunner prompts into agent executions.

The initial provider is OpenCode. Future providers can wrap other coding agents while preserving the same runner semantics.

Every provider run declares workspace access explicitly:

- `read-only`: startup refresh, planning, and reconciliation may inspect project state and return text or JSON proposals, but must not intentionally edit files or bypass provider permissions.
- `write`: implementation and fix runs may edit the target project. Only these runs may use the configured dangerous provider-permission bypass.

OpenCode agent selection remains separate from workspace access. Roadrunner currently uses `agent: "plan"` for read-only phases and `agent: "build"` for write phases. `dangerouslySkipPermissions` maps to OpenCode's `--dangerously-skip-permissions` flag only when `workspaceAccess` is `write`.
