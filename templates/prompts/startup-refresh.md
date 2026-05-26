# Roadrunner Startup Queue Refresh

You are running inside Roadrunner, an autonomous software delivery tool. Roadrunner is not a human user asking for options; it is asking for a read-only operational queue proposal.

Make decisions from `GOALS.md`, the roadmap, the seed queue, and concrete repository evidence. Do not ask open questions or leave queue choices unresolved when a reasonable path exists. Put genuine blockers in `blocked`; otherwise propose the next actionable queue.

Refresh the Roadrunner queue at run start. Treat this as a hard operational reset.

Do not edit files. This is a read-only planning pass. Return the refreshed queue as a JSON proposal in your response.

Use `GOALS.md`, the roadmap, and the current repository state to generate a fresh operational queue. Ignore any previous queue state except for the seed queue shown below, which was generated from the roadmap when possible.

The output queue must be valid Roadrunner queue JSON:

- preserve `version`, `model`, and `variant` from the seed queue;
- every item in `queue`, `history`, and `blocked` must include `id`, `phase`, `title`, `scope`, `prompt`, `acceptance`, and `verification`;
- use `phase`, not `roadmapPhase`, and use `acceptance`, not `acceptanceCriteria`;
- `scope`, `acceptance`, and `verification` must be non-empty string arrays;
- put already satisfied roadmap work in `history` with `completedAt` timestamps;
- put only currently relevant future work in `queue`;
- put still-relevant but blocked work in `blocked` with `blockedAt` and `blockedReason`;
- remove obsolete, duplicate, or superseded work instead of leaving it queued;
- prefer meaningful deliverable capabilities over tiny mechanical microtasks;
- keep each queued task independently verifiable;
- keep or add a final `integrated-product-validation` queue item when completed roadmap work lacks durable repository evidence that the whole solution has passed an end-to-end integrated gate after the latest relevant changes.

Mark work as done only when the acceptance criteria are satisfied by concrete repository evidence. If uncertain, keep the work queued and tighten the prompt or acceptance criteria.

The final integrated validation task should first audit whether the existing gate covers `GOALS.md` and the completed roadmap. If coverage is incomplete, it should add or update the missing tests, scripts, or documentation needed for a meaningful product gate before declaring success. It should then run the complete gate across engine, adapters, UI, E2E, documentation/AI checks, and optional completed research modules when applicable. It should fix issues found by that gate, but it should not add unrelated new roadmap features. Its acceptance criteria should require durable repository evidence, such as a validation report or documented product-gate command with latest results, so future startup refreshes can recognize that integrated validation already passed unless relevant files changed afterward.

In your response, include a short Markdown summary with these headings:

- `Inferred Done`
- `Still Needed`
- `Blocked`
- `Removed As Obsolete`
- `Next Task`

Then include exactly one fenced JSON block tagged `roadrunner-queue` containing the full proposed queue:

```json roadrunner-queue
{
  "version": 2,
  "model": "...",
  "variant": "...",
  "queue": [
    {
      "id": "kebab-case-task-id",
      "phase": "Roadmap phase name",
      "title": "Task title",
      "scope": ["path/or/component"],
      "prompt": "Implementation prompt for this task.",
      "acceptance": ["Observable acceptance criterion."],
      "verification": ["command to verify"]
    }
  ],
  "history": [],
  "blocked": []
}
```

## Goals

```md
{{GOALS_MD}}
```

## Roadmap

Roadmap parse status: {{ROADMAP_PARSE_STATUS}}

```md
{{ROADMAP_MD}}
```

## Seed Queue

```json
{{QUEUE_JSON}}
```
