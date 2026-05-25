# Roadrunner Startup Queue Refresh

Refresh the Roadrunner queue at run start. Treat this as a hard operational reset.

Only edit the configured queue JSON file at `{{QUEUE_PATH}}`. Do not edit source code, docs, prompts, tests, configs, lockfiles, generated files, or runtime artifacts.

Use `GOALS.md`, the roadmap, and the current repository state to generate a fresh operational queue. Ignore any previous queue state except for the seed queue shown below, which was generated from the roadmap when possible.

The output queue must be valid Roadrunner queue JSON:

- preserve `version`, `model`, and `variant` from the seed queue;
- put already satisfied roadmap work in `history` with `completedAt` timestamps;
- put only currently relevant future work in `queue`;
- put still-relevant but blocked work in `blocked` with `blockedAt` and `blockedReason`;
- remove obsolete, duplicate, or superseded work instead of leaving it queued;
- prefer meaningful deliverable capabilities over tiny mechanical microtasks;
- keep each queued task independently verifiable.

Mark work as done only when the acceptance criteria are satisfied by concrete repository evidence. If uncertain, keep the work queued and tighten the prompt or acceptance criteria.

In your response, include a short Markdown summary with these headings before or after editing the queue file:

- `Inferred Done`
- `Still Needed`
- `Blocked`
- `Removed As Obsolete`
- `Next Task`

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
