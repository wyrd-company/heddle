// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { instantiateTodoList } from "./todo-template.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("todo template instantiation", () => {
  it("fills nested task placeholders without changing the template artifact", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "heddle-todo-"));
    temporaryDirectories.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "todo-templates"));
    const path = join(repositoryRoot, "todo-templates", "sample-stage.json");
    const template = JSON.stringify({
      items: [
        {
          id: "inspect",
          text: "Inspect {{task.subject.name}} (#{{task.number}})",
        },
      ],
    });
    await writeFile(path, template);

    const list = await instantiateTodoList({
      repositoryRoot,
      sessionKey: "inspect-one",
      stage: "inspect",
      taskContract: { number: 17, subject: { name: "sample container" } },
      templateId: "sample-stage",
    });

    expect(list.items).toEqual([
      {
        checked: false,
        id: "inspect",
        text: "Inspect sample container (#17)",
      },
    ]);
    expect(await readFile(path, "utf8")).toBe(template);
  });

  it("rejects a placeholder absent from the task contract", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "heddle-todo-"));
    temporaryDirectories.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "todo-templates"));
    await writeFile(
      join(repositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "inspect", text: "Inspect {{task.missing}}" }],
      }),
    );

    await expect(
      instantiateTodoList({
        repositoryRoot,
        sessionKey: "inspect-one",
        stage: "inspect",
        taskContract: { title: "Inspect a sample" },
        templateId: "sample-stage",
      }),
    ).rejects.toThrow("task.missing");
  });

  it("rejects malformed placeholder syntax instead of retaining it literally", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "heddle-todo-"));
    temporaryDirectories.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "todo-templates"));
    await writeFile(
      join(repositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "inspect", text: "Inspect {{task..title}}" }],
      }),
    );

    await expect(
      instantiateTodoList({
        repositoryRoot,
        sessionKey: "inspect-one",
        stage: "inspect",
        taskContract: { title: "Inspect a sample" },
        templateId: "sample-stage",
      }),
    ).rejects.toThrow("invalid placeholder syntax");
  });

  it("rejects a placeholder that produces empty item text", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "heddle-todo-"));
    temporaryDirectories.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "todo-templates"));
    await writeFile(
      join(repositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "inspect", text: "{{task.summary}}" }],
      }),
    );

    await expect(
      instantiateTodoList({
        repositoryRoot,
        sessionKey: "inspect-one",
        stage: "inspect",
        taskContract: { summary: "  " },
        templateId: "sample-stage",
      }),
    ).rejects.toThrow("empty item text");
  });

  it("rejects duplicate item identities within one template", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "heddle-todo-"));
    temporaryDirectories.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "todo-templates"));
    await writeFile(
      join(repositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [
          { id: "inspect", text: "Inspect the sample" },
          { id: "inspect", text: "Inspect the label" },
        ],
      }),
    );

    await expect(
      instantiateTodoList({
        repositoryRoot,
        sessionKey: "inspect-one",
        stage: "inspect",
        taskContract: { title: "Inspect a sample" },
        templateId: "sample-stage",
      }),
    ).rejects.toThrow("duplicate item IDs");
  });
});
