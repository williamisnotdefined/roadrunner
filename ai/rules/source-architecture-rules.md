# Source Architecture Rules

## Always

- Keep modules cohesive around one reason to change.
- Keep `src` organized by the DDD-style folders `domain`, `application`, `infrastructure`, `infrastructure/providers`, `ui`, and `cli`.
- Prefer extracting pure parsing, validation, formatting, and calculation before extracting side-effectful orchestration.
- Keep provider-specific behavior under `src/infrastructure/providers`.
- Keep queue state transitions and validation centralized in queue-focused modules.
- Keep process spawning, timeout handling, process-group signaling, and process registry writes behind infrastructure helpers.
- Use explicit ports or interfaces only when they protect a real boundary, such as providers or process execution.
- Treat 250 lines as the target production module size and 300 lines as the review threshold.
- Keep `npm run size:check` passing when adding or growing authored TypeScript files.
- Update or split tests along the same behavioral boundaries as source refactors.

## Never

- Do not let application orchestration modules accumulate provider, shell, git, filesystem traversal, prompt rendering, and queue mutation details together.
- Do not import provider adapters from domain modules.
- Do not put UI, CLI, process, filesystem, or provider orchestration in `src/domain`.
- Do not let provider adapters mutate queue state or own Roadrunner workflow decisions.
- Do not create abstractions solely to satisfy a pattern name such as DRY, SOLID, or DDD; split only around stable responsibilities.
- Do not split code into tiny modules when the resulting boundary has no stable responsibility.
