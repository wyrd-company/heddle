// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import {
  requireRetainedTaskRepositoryScope,
  retainedTaskRepositoryScope,
  taskContractWithRepositoryScope,
  taskFrontMatterWithRepositoryScope,
} from "./task-repository-scope.js";

const task: BoardTask = {
  blocked: false,
  dependencies: [],
  frontMatter: { lifecycle: "sample-delivery" },
  id: 101,
  parent: 100,
  priority: "medium",
  status: "todo",
  tags: [],
  title: "Arrange sample records",
};

describe("task repository scope", () => {
  it("retains effective inherited scope in task contracts and front matter", () => {
    const repositories = ["sample-alpha", "sample-beta"];
    const contract = taskContractWithRepositoryScope(task, repositories);

    expect(contract).toMatchObject({ id: 101, repos: repositories });
    expect(contract).not.toHaveProperty("frontMatter");
    expect(taskFrontMatterWithRepositoryScope(task, repositories)).toEqual({
      lifecycle: "sample-delivery",
      repos: repositories,
    });
    expect(
      retainedTaskRepositoryScope(
        JSON.stringify({ taskContract: contract }),
        task.id,
      ),
    ).toEqual(repositories);
  });

  it.each([
    ["malformed context", "{"],
    [
      "malformed repository scope",
      JSON.stringify({ taskContract: { id: task.id, repos: ["../escape"] } }),
    ],
  ])("rejects %s instead of changing retained scope", (_, context) => {
    expect(() => retainedTaskRepositoryScope(context, task.id)).toThrow(
      `Task ${task.id} has invalid retained`,
    );
  });

  it("fails a legacy active context closed instead of adopting live board scope", () => {
    expect(() =>
      requireRetainedTaskRepositoryScope(
        JSON.stringify({ taskContract: { id: task.id } }),
        task.id,
      ),
    ).toThrow(
      `Task ${task.id} has no retained repository scope; operator recovery is required`,
    );
  });
});
