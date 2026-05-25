import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { defaultModel, defaultVariant, loadContext, writeJson } from "../src/config.js";
import { importRoadmap, queueFileFromRoadmap, queueFileFromRoadmapFile } from "../src/roadmap.js";
import type { QueueFile } from "../src/queue.js";

describe("roadmap", () => {
  test("parses roadmap markdown into queue file", () => {
    const queueFile = queueFileFromRoadmap(sampleRoadmap(), {});

    expect(queueFile.queue.length).toBe(1);
    expect(queueFile.queue[0]?.id).toBe("first-step");
    expect(queueFile.queue[0]?.title).toBe("Build first step");
    expect(queueFile.queue[0]?.scope).toEqual(["README.md", "src/feature.ts"]);
    expect(queueFile.queue[0]?.verification).toEqual(["npm run check"]);
  });

  test("parses roadmap with configured model and variant", () => {
    const queueFile = queueFileFromRoadmap(sampleRoadmap(), { model: "custom-model", variant: "low" });

    expect(queueFile.model).toBe("custom-model");
    expect(queueFile.variant).toBe("low");
  });

  test("parses alternate heading forms and comma-separated scope", () => {
    const queueFile = queueFileFromRoadmap(
      `# Roadmap

## Notes

This heading is documentation, not a queue step.

Unknown: ignored until a known field appears.

## second-step - Build second step

Phase: Bootstrap
Scope: README.md, src/index.ts
Prompt: Do the second thing.
Acceptance:
1. works
Acceptance:
2. still works
Verification:
1) npm test
Unknown After Verification: ignored without extending verification

### [third-step] Build third step

Phase: Bootstrap
Scope:
* package.json
Prompt: Do the third thing.
Acceptance:
* works too
Verification:
* npm run check
`,
      {},
    );

    expect(queueFile.queue.map((step) => step.id)).toEqual(["second-step", "third-step"]);
    expect(queueFile.queue[0]?.scope).toEqual(["README.md", "src/index.ts"]);
    expect(queueFile.queue[0]?.acceptance).toEqual(["works", "still works"]);
    expect(queueFile.queue[0]?.verification).toEqual(["npm test"]);
  });

  test("rejects roadmap steps with missing required fields", () => {
    expect(() => queueFileFromRoadmap("## first-step: Build first step\n\nPhase: Bootstrap\n", {})).toThrow(/missing scope field/);
  });

  test("rejects roadmaps without steps and duplicate IDs", () => {
    expect(() => queueFileFromRoadmap("# Empty\n", {})).toThrow(/at least one step/);
    expect(() => queueFileFromRoadmap(`${sampleRoadmap()}\n${sampleRoadmap()}`, {})).toThrow(/duplicate roadmap step id/);
  });

  test("importRoadmap preserves closed queue records", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-"));
    try {
      await writeFile(
        path.join(tempDir, "ROADMAP.md"),
        `${sampleRoadmap()}\n\n## completed-step: Completed\n\nPhase: Done\nScope: README.md\nPrompt: Already done.\nAcceptance:\n- done\nVerification:\n- npm test\n`,
      );
      const context = await loadContext(tempDir, { _: [] });
      const existing: QueueFile = {
        version: 2,
        model: defaultModel,
        variant: defaultVariant,
        queue: [],
        history: [
          {
            id: "completed-step",
            phase: "Done",
            title: "Completed",
            scope: ["README.md"],
            prompt: "Already done.",
            acceptance: ["done"],
            verification: ["npm test"],
          },
        ],
        blocked: [],
      };
      await writeJson(context.paths.queue, existing);

      const imported = await importRoadmap(context);
      const written = JSON.parse(await readFile(context.paths.queue, "utf8")) as QueueFile;

      expect(imported.queue.map((step) => step.id)).toEqual(["first-step"]);
      expect(written.queue.map((step) => step.id)).toEqual(["first-step"]);
      expect(written.history.length).toBe(1);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("importRoadmap preserves existing open steps absent from the roadmap", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-open-"));
    try {
      await writeFile(path.join(tempDir, "ROADMAP.md"), sampleRoadmap());
      const context = await loadContext(tempDir, { _: [] });
      const existing: QueueFile = {
        version: 2,
        model: defaultModel,
        variant: defaultVariant,
        queue: [
          {
            id: "manual-step",
            phase: "Manual",
            title: "Manual step",
            scope: ["README.md"],
            prompt: "Keep this manually queued step.",
            acceptance: ["still queued"],
            verification: ["npm test"],
          },
        ],
        history: [],
        blocked: [],
      };
      await writeJson(context.paths.queue, existing);

      const imported = await importRoadmap(context);

      expect(imported.queue.map((step) => step.id)).toEqual(["first-step", "manual-step"]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("importRoadmap writes a queue when no existing queue is present", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-new-"));
    try {
      await writeFile(path.join(tempDir, "ROADMAP.md"), sampleRoadmap());
      const context = await loadContext(tempDir, { _: [] });

      const imported = await importRoadmap(context);

      expect(imported.queue.map((step) => step.id)).toEqual(["first-step"]);
      expect(JSON.parse(await readFile(context.paths.queue, "utf8")).queue).toHaveLength(1);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("importRoadmap accepts configured model and variant", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-custom-model-"));
    try {
      await writeFile(path.join(tempDir, "ROADMAP.md"), sampleRoadmap());
      await writeJson(path.join(tempDir, ".roadrunner/config.json"), { model: "custom-model", variant: "low" });
      const context = await loadContext(tempDir, { _: [] });

      const imported = await importRoadmap(context);

      expect(imported.model).toBe("custom-model");
      expect(imported.variant).toBe("low");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("importRoadmap rejects invalid existing queues", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-invalid-existing-"));
    try {
      await writeFile(path.join(tempDir, "ROADMAP.md"), sampleRoadmap());
      const context = await loadContext(tempDir, { _: [] });
      await writeJson(context.paths.queue, { version: 1 });

      await expect(importRoadmap(context)).rejects.toThrow(/queue.version must be 2/);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("queueFileFromRoadmapFile accepts roadmap paths outside the root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-outside-"));
    try {
      const roadmapPath = path.join(outside, "ROADMAP.md");
      await writeFile(roadmapPath, sampleRoadmap());
      const queueFile = await queueFileFromRoadmapFile({
        config: { allowNestedOpenCode: false, model: defaultModel, paths: {}, provider: "opencode", variant: defaultVariant },
        paths: { goals: path.join(root, "GOALS.md"), roadmap: roadmapPath } as never,
        root,
      });

      expect(queueFile.queue.map((step) => step.id)).toEqual(["first-step"]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });
});

function sampleRoadmap(): string {
  return `# Roadmap

## first-step: Build first step

Phase: Bootstrap
Scope:
- README.md
- src/feature.ts

Prompt: Implement the first concrete step.

Acceptance:
- docs explain the behavior
- tests cover the behavior

Verification:
- npm run check
`;
}
