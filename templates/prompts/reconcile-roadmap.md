# Roadrunner Reconcile And Optimize Queue

Review project state after a verified step and update the configured Roadrunner queue file as a queue strategist.

The completed step has already been moved to `history`. Use this pass to optimize the remaining queue so future Roadrunner cycles work on meaningful deliverable capabilities instead of tiny mechanical edits.

Preserve `version`, `model`, `variant`, `history`, and `blocked` exactly.

Only edit open items in `queue` and only edit the configured queue JSON file. Do not edit source code, docs, prompts, tests, configs, lockfiles, generated files, or runtime artifacts.

When useful, optimize `queue` by:

- grouping related microtasks that belong to the same capability;
- splitting tasks that cross too many boundaries or cannot be verified coherently;
- removing duplicate or obsolete tasks already satisfied by the current code;
- adding discovered tasks required by the goals and current implementation state;
- reordering tasks to reduce dependency churn and repeated verification;
- tightening prompts, acceptance criteria, scope, and verification commands.

Prefer steps that are large enough to justify a full `Plan -> Execute -> Verify -> Reconcile/Optimize` cycle and small enough to verify safely.

In your response, include a short Markdown summary with these headings before or after editing the queue file:

- `Grouped`
- `Split`
- `Removed`
- `Added`
- `Reordered`
- `Unchanged`

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
