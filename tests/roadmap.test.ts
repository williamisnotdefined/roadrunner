import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { defaultModel, defaultVariant, loadContext, writeJson } from "../src/infrastructure/config.js";
import { queueFileFromRoadmap, queueFileFromRoadmapFile } from "../src/domain/roadmap.js";

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
Out-of-scope:
- do not treat this as verification

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

  test("keeps unknown labels inside multiline prompt fields", () => {
    const queueFile = queueFileFromRoadmap(
      `# Roadmap

## first-step: Build first step

Phase: Bootstrap
Scope: README.md
Prompt: Implement the thing.
Note: This line is part of the prompt, not a roadmap field.
Example: Keep this too.
Acceptance:
- works
Verification:
- npm test
`,
      {},
    );

    expect(queueFile.queue[0]?.prompt).toContain("Note: This line is part of the prompt");
    expect(queueFile.queue[0]?.prompt).toContain("Example: Keep this too");
  });

  test("ignores step-like headings inside fenced code blocks", () => {
    const queueFile = queueFileFromRoadmap(
      `${sampleRoadmap()}

\`\`\`md
## fake-step: This is only documentation

Phase: Docs
Scope: README.md
Prompt: Do not parse this.
Acceptance:
- ignored
Verification:
- ignored
\`\`\`
`,
      {},
    );

    expect(queueFile.queue.map((step) => step.id)).toEqual(["first-step"]);
    expect(queueFile.queue[0]?.phase).toBe("Bootstrap");
    expect(queueFile.queue[0]?.scope).toEqual(["README.md", "src/feature.ts"]);
  });

  test("keeps fenced code inside prompt fields without parsing labels inside it", () => {
    const queueFile = queueFileFromRoadmap(
      `# Roadmap

## first-step: Build first step

Phase: Bootstrap
Scope: README.md
Prompt: Use this example:

\`\`\`md
Phase: Not a real phase
Acceptance:
- not a real acceptance item
\`\`\`

Acceptance:
- works
Verification:
- npm test
`,
      {},
    );

    expect(queueFile.queue[0]?.phase).toBe("Bootstrap");
    expect(queueFile.queue[0]?.prompt).toContain("Phase: Not a real phase");
    expect(queueFile.queue[0]?.acceptance).toEqual(["works"]);
  });

  test("rejects roadmap steps with missing required fields", () => {
    expect(() => queueFileFromRoadmap("## first-step: Build first step\n\nPhase: Bootstrap\n", {})).toThrow(/missing scope field/);
  });

  test("rejects roadmaps without steps and duplicate IDs", () => {
    expect(() => queueFileFromRoadmap("# Empty\n", {})).toThrow(/at least one step/);
    expect(() => queueFileFromRoadmap(`${sampleRoadmap()}\n${sampleRoadmap()}`, {})).toThrow(/duplicate roadmap step id/);
  });

  test("queueFileFromRoadmapFile accepts configured model and variant", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "roadrunner-roadmap-custom-model-"));
    try {
      await writeFile(path.join(tempDir, "ROADMAP.md"), sampleRoadmap());
      await writeJson(path.join(tempDir, ".roadrunner/config.json"), { model: "custom-model", variant: "low" });
      const context = await loadContext(tempDir, { _: [] });

      const imported = await queueFileFromRoadmapFile(context);

      expect(imported.model).toBe("custom-model");
      expect(imported.variant).toBe("low");
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
        config: { allowNestedOpenCode: false, allowedVerificationCommands: [], autoRestartIdleMs: 600000, dangerouslySkipPermissions: false, maxAutoRestartsPerStep: 3, model: defaultModel, paths: {}, provider: "opencode", variant: defaultVariant },
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
