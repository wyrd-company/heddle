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

const pinnedSkillFixture = async (
  serializedSkill?: string,
  keepSkillFolder = false,
): Promise<{ commitSha: string; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "pinned-skill-store-"));
  cleanup.push(root);
  await mkdir(join(root, "handoff-templates"));
  await mkdir(join(root, "skills", "evidence-review"), { recursive: true });
  await writeFile(
    join(root, "handoff-templates", "standard.md"),
    [
      "---",
      "$schema: https://wyrd.company/heddle/handoff-template.schema.json",
      "relationships:",
      "  implements: heddle",
      "format: heddle.handoff-template",
      "version: 1",
      "kind: standard",
      "---",
      '{{ skill("evidence-review").description }}',
      "",
    ].join("\n"),
  );
  if (serializedSkill !== undefined) {
    await writeFile(
      join(root, "skills", "evidence-review", "SKILL.md"),
      serializedSkill,
    );
  } else if (keepSkillFolder) {
    await writeFile(
      join(root, "skills", "evidence-review", "README.md"),
      "# Evidence review fixture\n",
    );
  }
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execute("git", ["add", "."], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add pinned artifacts",
    ],
    { cwd: root },
  );
  const commitSha = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  return { commitSha, root };
};

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
    commitSha: "a".repeat(40),
    body: [
      "# {{ task.title }}",
      "",
      "{% for list in handoff.todoList.lists %}{% for item in list.items %}- [{% if item.checked %}x{% else %} {% endif %}] {{ item.text }}",
      "{% endfor %}{% endfor %}",
    ].join("\n"),
    includes: {},
    kind: "standard",
    path: "handoff-templates/standard.md",
    skills: {},
  },
  ...overrides,
});

describe("renderStageHandoff", () => {
  it.each(["claudeAgent", "codex", "cursor", "grok", "opencode"])(
    "keeps the %s registration secret out of the rendered handoff",
    (driver) => {
      const rendered = renderStageHandoff(input({ driver }));
      const [frontMatter, body] = rendered.split("\n---\n", 2);

      expect(frontMatter).toContain('format: "heddle.stage-handoff"');
      expect(frontMatter).toContain('instanceId: "instance-17"');
      expect(frontMatter).toContain('sessionKey: "session-1"');
      expect(frontMatter).toContain("taskId: 17");
      expect(frontMatter).toContain('stage: "arrange"');
      expect(rendered).not.toContain("opaque-fallback-token");
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

  it("renders every field from a declared pinned skill through the skill global", () => {
    const rendered = renderStageHandoff(
      input({
        template: {
          ...input().template,
          body: [
            '{{ skill("evidence-review").name }}',
            '{{ skill("evidence-review").path }}',
            '{{ skill("evidence-review").description }}',
          ].join("\n"),
          skills: {
            "evidence-review": {
              description: "Inspect evidence before recording a result.",
              name: "evidence-review",
              path: "skills/evidence-review/SKILL.md",
              source: "Pinned skill source",
            },
          },
        },
      }),
    );

    expect(rendered).toContain("evidence-review");
    expect(rendered).toContain("skills/evidence-review/SKILL.md");
    expect(rendered).toContain("Inspect evidence before recording a result.");
  });

  it("detects skill-resolved content that changes between deterministic renders", () => {
    let reads = 0;
    const skills = new Proxy(input().template.skills, {
      get: (_target, property) => {
        if (property !== "evidence-review") return undefined;
        reads += 1;
        return {
          description: `Description ${reads}`,
          name: "evidence-review",
          path: "skills/evidence-review/SKILL.md",
          source: "Pinned skill source",
        };
      },
      ownKeys: () => ["evidence-review"],
      getOwnPropertyDescriptor: () => ({
        configurable: true,
        enumerable: true,
      }),
    });

    expect(() =>
      renderStageHandoff(
        input({
          template: {
            ...input().template,
            body: '{{ skill("evidence-review").description }}',
            skills,
          },
        }),
      ),
    ).toThrow("Handoff template render is not deterministic");
  });

  it("rejects a correlation token anywhere in a declared pinned skill source", () => {
    expect(() =>
      renderStageHandoff(
        input({
          template: {
            ...input().template,
            skills: {
              "evidence-review": {
                description: "Inspect evidence before recording a result.",
                name: "evidence-review",
                path: "skills/evidence-review/SKILL.md",
                source: "Body contains opaque-fallback-token",
              },
            },
          },
        }),
      ),
    ).toThrow("Pinned skill source contains the correlation token");
  });

  it("rejects a skill global request not declared by the stage", () => {
    expect(() =>
      renderStageHandoff(
        input({
          template: {
            ...input().template,
            body: '{{ skill("unlisted-skill").description }}',
          },
        }),
      ),
    ).toThrow("requested undeclared pinned skill");
  });

  it("renders an include from the pinned template commit", () => {
    const rendered = renderStageHandoff(
      input({
        template: {
          ...input().template,
          body: '{% include "handoff-templates/includes/summary.md" %}',
          includes: {
            "handoff-templates/includes/summary.md":
              "Included {{ task.title }}",
          },
        },
      }),
    );

    expect(rendered).toContain("Included Arrange a sample");
  });

  it.each([
    "handoff-templates/includes/../outside.md",
    "handoff-templates/outside.md",
    "handoff-templates/includes/nested\\..\\outside.md",
    "handoff-templates/includes/",
  ])("rejects contained-include violation %s", (includePath) => {
    expect(() =>
      renderStageHandoff(
        input({
          template: {
            ...input().template,
            body: `{% include ${JSON.stringify(includePath)} %}`,
            includes: { [includePath]: "Outside content" },
          },
        }),
      ),
    ).toThrow(
      "Handoff include must use a repository-relative path inside handoff-templates/includes/",
    );
  });

  it.each([
    ['{% extends "handoff-templates/includes/layout.md" %}', "Extends"],
    ['{% import "handoff-templates/includes/macros.md" as macros %}', "Import"],
    [
      '{% from "handoff-templates/includes/macros.md" import item %}',
      "FromImport",
    ],
  ])("rejects unsupported %s syntax", (body, syntax) => {
    expect(() =>
      renderStageHandoff(input({ template: { ...input().template, body } })),
    ).toThrow(`uses unsupported ${syntax} syntax; only include is supported`);
  });

  it("rejects unsupported import syntax inside an included file", () => {
    const includePath = "handoff-templates/includes/summary.md";
    expect(() =>
      renderStageHandoff(
        input({
          template: {
            ...input().template,
            body: `{% include "${includePath}" %}`,
            includes: {
              [includePath]:
                '{% import "handoff-templates/includes/macros.md" as macros %}',
            },
          },
        }),
      ),
    ).toThrow("uses unsupported Import syntax; only include is supported");
  });

  it("detects an included body that changes between deterministic renders", () => {
    const includePath = "handoff-templates/includes/summary.md";
    let reads = 0;
    const includes = new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, property) => {
          if (property !== includePath) return undefined;
          reads += 1;
          return reads === 1 ? "First body" : "Second body";
        },
      },
    );

    expect(() =>
      renderStageHandoff(
        input({
          template: {
            ...input().template,
            body: `{% include "${includePath}" %}`,
            includes,
          },
        }),
      ),
    ).toThrow("Handoff template render is not deterministic");
  });

  const withInclude = (body: string) => {
    const includePath = "handoff-templates/includes/summary.md";
    return input({
      template: {
        ...input().template,
        body: `{% include "${includePath}" %}`,
        includes: { [includePath]: body },
      },
    });
  };

  it("rejects the correlation token from included content", () => {
    expect(() =>
      renderStageHandoff(withInclude("opaque-fallback-token")),
    ).toThrow("Handoff template body contains the correlation token");
  });

  it("disables the random filter in included content", () => {
    expect(() =>
      renderStageHandoff(withInclude("{{ [1, 2, 3] | random }}")),
    ).toThrow(/filter not found: random/);
  });

  it("disables the date filter in included content", () => {
    expect(() =>
      renderStageHandoff(withInclude("{{ '2026-01-01' | date }}")),
    ).toThrow(/filter not found: date/);
  });

  it("rejects a template body that exposes the registration token", () => {
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
  it("rejects a declared skill whose pinned folder is missing", async () => {
    const { commitSha, root } = await pinnedSkillFixture();

    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["evidence-review"],
      ),
    ).rejects.toThrow(
      `Pinned skill "evidence-review" is unavailable at commit ${commitSha}: skills/evidence-review/SKILL.md`,
    );
  });

  it("rejects a declared skill folder with no pinned SKILL.md", async () => {
    const { commitSha, root } = await pinnedSkillFixture(undefined, true);

    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["evidence-review"],
      ),
    ).rejects.toThrow(
      `Pinned skill "evidence-review" is unavailable at commit ${commitSha}: skills/evidence-review/SKILL.md`,
    );
  });

  it("rejects a pinned skill whose front-matter name differs from its folder", async () => {
    const { commitSha, root } = await pinnedSkillFixture(
      "---\nname: other-skill\ndescription: Inspect evidence.\n---\n\nInspect it.\n",
    );

    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["evidence-review"],
      ),
    ).rejects.toThrow(
      'Pinned skill "evidence-review" front matter name must equal its folder name',
    );
  });

  it("rejects a pinned skill with no front-matter description", async () => {
    const { commitSha, root } = await pinnedSkillFixture(
      "---\nname: evidence-review\n---\n\nInspect it.\n",
    );

    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["evidence-review"],
      ),
    ).rejects.toThrow(
      'Pinned skill "evidence-review" front matter description must contain 1 to 1,024 characters',
    );
  });

  it("counts Unicode code points in a 1,024-character description", async () => {
    const description = "😀".repeat(1_024);
    const { commitSha, root } = await pinnedSkillFixture(
      `---\nname: evidence-review\ndescription: ${description}\n---\n\nInspect it.\n`,
    );

    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["evidence-review"],
      ),
    ).resolves.toMatchObject({
      skills: { "evidence-review": { description } },
    });
  });

  it("rejects a pinned skill with a 1,025-character description", async () => {
    const { commitSha, root } = await pinnedSkillFixture(
      `---\nname: evidence-review\ndescription: ${"a".repeat(1_025)}\n---\n\nInspect it.\n`,
    );

    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["evidence-review"],
      ),
    ).rejects.toThrow(
      'Pinned skill "evidence-review" front matter description must contain 1 to 1,024 characters',
    );
  });

  it.each([
    {
      diagnostic: "has no YAML front matter",
      label: "no front matter",
      source: "# Evidence review\n",
    },
    {
      diagnostic: "front matter is not closed",
      label: "unclosed front matter",
      source: "---\nname: evidence-review\n",
    },
    {
      diagnostic: "front matter is invalid",
      label: "invalid front matter",
      source: "---\nname: [\ndescription: Inspect evidence.\n---\n",
    },
  ])("rejects a pinned skill with $label", async ({ diagnostic, source }) => {
    const { commitSha, root } = await pinnedSkillFixture(source);

    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["evidence-review"],
      ),
    ).rejects.toThrow(diagnostic);
  });

  it("rejects a non-kebab pinned skill name", async () => {
    const { commitSha, root } = await pinnedSkillFixture(
      "---\nname: evidence-review\ndescription: Inspect evidence.\n---\n\nInspect it.\n",
    );
    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        ["EvidenceReview"],
      ),
    ).rejects.toThrow('Pinned skill name is invalid: "EvidenceReview"');
  });

  it("rejects a pinned skill name longer than 64 characters", async () => {
    const name = "a".repeat(65);
    const { commitSha, root } = await pinnedSkillFixture(
      `---\nname: ${name}\ndescription: Inspect evidence.\n---\n\nInspect it.\n`,
    );
    await expect(
      new GitHandoffTemplateStore(root).read(
        {
          commitSha,
          path: "handoff-templates/standard.md",
        },
        [name],
      ),
    ).rejects.toThrow(`Pinned skill name is invalid: ${JSON.stringify(name)}`);
  });

  it("reads entry and include bytes from one pinned commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-template-store-"));
    cleanup.push(root);
    await mkdir(join(root, "handoff-templates", "includes", "nested"), {
      recursive: true,
    });
    await mkdir(join(root, "skills", "evidence-review"), { recursive: true });
    const path = join(root, "handoff-templates", "standard.md");
    const includePath = join(
      root,
      "handoff-templates",
      "includes",
      "summary.md",
    );
    const nestedIncludePath = join(
      root,
      "handoff-templates",
      "includes",
      "nested",
      "detail.md",
    );
    const original = [
      "---",
      "$schema: https://wyrd.company/heddle/handoff-template.schema.json",
      "relationships:",
      "  implements: heddle",
      "format: heddle.handoff-template",
      "version: 1",
      "kind: standard",
      "---",
      '{% include "handoff-templates/includes/summary.md" %}',
      '{% include "handoff-templates/includes/nested/detail.md" %}',
      '{{ skill("evidence-review").description }}',
      "",
    ].join("\n");
    const skillPath = join(root, "skills", "evidence-review", "SKILL.md");
    const originalSkill = [
      "---",
      "name: evidence-review",
      "description: Inspect pinned evidence.",
      "---",
      "",
      "Inspect the supplied evidence.",
      "",
    ].join("\n");
    await writeFile(path, original);
    await writeFile(includePath, "Pinned {{ task.title }}\n");
    await writeFile(nestedIncludePath, "Nested pinned content\n");
    await writeFile(skillPath, originalSkill);
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    await execute("git", ["add", "handoff-templates", "skills"], { cwd: root });
    await execute(
      "git",
      [
        "-c",
        "user.name=Sample User",
        "-c",
        "user.email=sample@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "add sample template",
      ],
      { cwd: root },
    );
    const firstCommit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    await writeFile(
      path,
      original.replace(
        '{% include "handoff-templates/includes/summary.md" %}',
        'Live entry changed\n{% include "handoff-templates/includes/summary.md" %}',
      ),
    );
    await writeFile(includePath, "Live changed {{ task.title }}\n");
    await writeFile(nestedIncludePath, "Nested live content\n");
    await writeFile(
      skillPath,
      originalSkill.replace(
        "Inspect pinned evidence.",
        "Inspect live evidence.",
      ),
    );

    const template = await new GitHandoffTemplateStore(root).read(
      {
        commitSha: firstCommit,
        path: "handoff-templates/standard.md",
      },
      ["evidence-review"],
    );

    expect(template.body).toContain("summary.md");
    expect(template.body).not.toContain("Live entry changed");
    expect(template.includes).toEqual({
      "handoff-templates/includes/summary.md": "Pinned {{ task.title }}\n",
      "handoff-templates/includes/nested/detail.md": "Nested pinned content\n",
    });
    expect(template.skills["evidence-review"]).toMatchObject({
      description: "Inspect pinned evidence.",
      name: "evidence-review",
      path: "skills/evidence-review/SKILL.md",
    });
    const pinnedRender = renderStageHandoff(input({ template }));
    expect(pinnedRender).toContain("Pinned Arrange a sample");
    expect(pinnedRender).not.toContain("Live changed");
    expect(pinnedRender).toContain("Nested pinned content");
    expect(pinnedRender).toContain("Inspect pinned evidence.");
    expect(pinnedRender).not.toContain("Inspect live evidence.");
    await expect(
      execute(
        "git",
        ["rev-parse", `refs/heddle/handoff-templates/${firstCommit}`],
        { cwd: root },
      ),
    ).resolves.toMatchObject({ stdout: `${firstCommit}\n` });

    await execute("git", ["add", "handoff-templates", "skills"], { cwd: root });
    await execute(
      "git",
      [
        "-c",
        "user.name=Sample User",
        "-c",
        "user.email=sample@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "change sample template",
      ],
      { cwd: root },
    );
    const secondCommit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const stillPinned = await new GitHandoffTemplateStore(root).read(
      {
        commitSha: firstCommit,
        path: "handoff-templates/standard.md",
      },
      ["evidence-review"],
    );
    expect(renderStageHandoff(input({ template: stillPinned }))).toContain(
      "Pinned Arrange a sample",
    );
    expect(renderStageHandoff(input({ template: stillPinned }))).not.toContain(
      "Live changed",
    );
    expect(renderStageHandoff(input({ template: stillPinned }))).toContain(
      "Inspect pinned evidence.",
    );

    const changed = await new GitHandoffTemplateStore(root).read(
      {
        commitSha: secondCommit,
        path: "handoff-templates/standard.md",
      },
      ["evidence-review"],
    );

    expect(changed.body).toContain("Live entry changed");
    expect(changed.includes).toEqual({
      "handoff-templates/includes/summary.md":
        "Live changed {{ task.title }}\n",
      "handoff-templates/includes/nested/detail.md": "Nested live content\n",
    });
    const changedRender = renderStageHandoff(input({ template: changed }));
    expect(changedRender).toContain("Live entry changed");
    expect(changedRender).toContain("Live changed Arrange a sample");
    expect(changedRender).toContain("Nested live content");
    expect(changedRender).toContain("Inspect live evidence.");
  });

  it.each(["a".repeat(41), "A".repeat(40)])(
    "rejects invalid commit pin %s",
    async (commitSha) => {
      await expect(
        new GitHandoffTemplateStore(".").read({
          commitSha,
          path: "handoff-templates/standard.md",
        }),
      ).rejects.toThrow("Handoff template commit SHA is invalid");
    },
  );

  it("rejects an entry path that escapes the handoff template directory", async () => {
    await expect(
      new GitHandoffTemplateStore(".").read({
        commitSha: "a".repeat(40),
        path: "handoff-templates/../outside.md",
      }),
    ).rejects.toThrow(
      "Handoff template path must name a direct kebab-case Markdown artifact",
    );
  });

  it("rejects a Git blob where the reference requires a commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-template-store-"));
    cleanup.push(root);
    await writeFile(join(root, "sample.txt"), "sample content\n");
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    const blobHash = (
      await execute("git", ["hash-object", "-w", "sample.txt"], { cwd: root })
    ).stdout.trim();

    await expect(
      new GitHandoffTemplateStore(root).read({
        commitSha: blobHash,
        path: "handoff-templates/standard.md",
      }),
    ).rejects.toThrow(
      `Pinned handoff template commit is unavailable: ${blobHash}`,
    );
  });
});
