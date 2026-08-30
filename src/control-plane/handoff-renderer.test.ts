// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { assembleStageHandoff } from "./handoff-assembler.js";
import {
  HandoffRenderError,
  renderStageHandoff,
  type HandoffRenderInput,
} from "./handoff-renderer.js";
import { GitHandoffTemplateStore } from "./handoff-template-store.js";

const execute = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const input = (
  overrides: Partial<HandoffRenderInput> = {},
): HandoffRenderInput => ({
  correlationToken: "opaque-fallback-token",
  driver: "codex",
  handoff: assembleStageHandoff({
    correlationToken: "opaque-fallback-token",
    skillPointer: "skill://arrange",
    stage: {
      kind: "standard",
      name: "arrange",
      priorStageOutputs: [{ count: 2 }],
    },
    taskContract: { id: 17, title: "Arrange a sample" },
    todoList: {
      format: "heddle.todo-state",
      lists: [
        {
          items: [
            { checked: true, id: "first", text: "Inspect the sample" },
            { checked: false, id: "second", text: "Record the result" },
          ],
          sessionKey: "session-1",
          stage: "arrange",
          template: "sample-list",
        },
      ],
      version: 1,
    },
  }),
  instanceId: "instance-17",
  sessionKey: "session-1",
  stage: "arrange",
  task: { id: 17, title: "Arrange a sample" },
  taskId: 17,
  template: {
    blobHash: "a".repeat(40),
    body: [
      "# {{ task.title }}",
      "",
      "{% for list in handoff.todoList.lists %}{% for item in list.items %}- [{% if item.checked %}x{% else %} {% endif %}] {{ item.text }}",
      "{% endfor %}{% endfor %}",
    ].join("\n"),
    kind: "standard",
    path: "handoff-templates/standard.md",
  },
  ...overrides,
});

describe("renderStageHandoff", () => {
  it.each(["claudeAgent", "codex", "cursor"])(
    "places the %s fallback secret once in identity front matter and never in the body",
    (driver) => {
      const rendered = renderStageHandoff(input({ driver }));
      const [frontMatter, body] = rendered.split("\n---\n", 2);

      expect(frontMatter).toContain('format: "heddle.stage-handoff"');
      expect(frontMatter).toContain('instanceId: "instance-17"');
      expect(frontMatter).toContain('sessionKey: "session-1"');
      expect(frontMatter).toContain("taskId: 17");
      expect(frontMatter).toContain('stage: "arrange"');
      expect(rendered.match(/opaque-fallback-token/g)).toHaveLength(1);
      expect(body).not.toContain("opaque-fallback-token");
      expect(body).toContain("- [x] Inspect the sample");
      expect(body).toContain("- [ ] Record the result");
    },
  );

  it("fails closed when a strict template variable is missing", () => {
    const testInput = input({
      template: {
        ...input().template,
        body: "{{ task.unavailable }}",
      },
    });

    expect(() => renderStageHandoff(testInput)).toThrow(HandoffRenderError);
    expect(() => renderStageHandoff(testInput)).toThrow(/undefined value/);
  });

  it("disables the nondeterministic random filter", () => {
    expect(() =>
      renderStageHandoff(
        input({
          template: {
            ...input().template,
            body: "{{ [1, 2, 3] | random }}",
          },
        }),
      ),
    ).toThrow(/filter not found: random/);
  });

  it("renders byte-identically from identical stored inputs", () => {
    const testInput = input();
    expect(renderStageHandoff(testInput)).toBe(renderStageHandoff(testInput));
  });

  it("rejects a template body that duplicates the fallback token", () => {
    expect(() =>
      renderStageHandoff(
        input({ task: { id: 17, title: "opaque-fallback-token" } }),
      ),
    ).toThrow("Handoff template body contains the correlation token");
  });

  it("fails closed for a driver without a measured authentication policy", () => {
    expect(() =>
      renderStageHandoff(input({ driver: "sample-driver" })),
    ).toThrow("has no measured Heddle MCP authentication policy");
  });
});

describe("GitHandoffTemplateStore", () => {
  it("reads exact pinned bytes instead of a changed working-tree path", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-template-store-"));
    cleanup.push(root);
    await mkdir(join(root, "handoff-templates"));
    const path = join(root, "handoff-templates", "standard.md");
    const original = [
      "---",
      "$schema: https://wyrd.company/heddle/handoff-template.schema.json",
      "relationships:",
      "  implements: heddle",
      "format: heddle.handoff-template",
      "version: 1",
      "kind: standard",
      "---",
      "Pinned {{ task.title }}",
      "",
    ].join("\n");
    await writeFile(path, original);
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    const { stdout } = await execute(
      "git",
      ["hash-object", "-w", "handoff-templates/standard.md"],
      { cwd: root },
    );
    await writeFile(path, original.replace("Pinned", "Live changed"));

    const template = await new GitHandoffTemplateStore(root).read({
      blobHash: stdout.trim(),
      path: "handoff-templates/standard.md",
    });

    expect(template.body).toBe("Pinned {{ task.title }}\n");
    expect(template.body).not.toContain("Live changed");
  });
});
