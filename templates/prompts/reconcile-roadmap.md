# Roadrunner Reconcile And Optimize Queue

Review project state after a verified step and propose an updated Roadrunner queue as a queue strategist.

The completed step has already been moved to `history`. Use this pass to optimize the remaining queue so future Roadrunner cycles work on meaningful deliverable capabilities instead of tiny mechanical edits.

Preserve `version`, `model`, `variant`, `history`, and `blocked` exactly.

Do not edit files. This is a read-only planning pass. Only change open items in `queue` in the JSON proposal.

Every open item in `queue` must include `id`, `phase`, `title`, `scope`, `prompt`, `acceptance`, and `verification`. Use `phase`, not `roadmapPhase`, and use `acceptance`, not `acceptanceCriteria`. `scope`, `acceptance`, and `verification` must be non-empty string arrays.

When useful, optimize `queue` by:

- grouping related microtasks that belong to the same capability;
- splitting tasks that cross too many boundaries or cannot be verified coherently;
- removing duplicate or obsolete tasks already satisfied by the current code;
- adding discovered tasks required by the goals and current implementation state;
- reordering tasks to reduce dependency churn and repeated verification;
- tightening prompts, acceptance criteria, scope, and verification commands.

Prefer steps that are large enough to justify a full `Plan -> Execute -> Verify -> Reconcile/Optimize` cycle and small enough to verify safely.

In your response, include a short Markdown summary with these headings:

- `Grouped`
- `Split`
- `Removed`
- `Added`
- `Reordered`
- `Unchanged`

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

## Queue

```json
{{QUEUE_JSON}}
```

## Completed Step

```json
{{STEP_JSON}}
```
