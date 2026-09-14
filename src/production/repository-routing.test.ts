// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import {
  TaskRepositoryRouter,
  TaskRoutingAttentionError,
} from "./repository-routing.js";

const task = (
  input: Partial<BoardTask> & Pick<BoardTask, "id">,
): BoardTask => ({
  blocked: false,
  dependencies: [],
  frontMatter: {},
  priority: "medium",
  status: "todo",
  tags: [],
  title: "Arrange sample items",
  ...input,
});

describe("TaskRepositoryRouter", () => {
  it("inherits the complete epic repository scope and resolves local roots", () => {
    const router = new TaskRepositoryRouter("/workspaces");
    const epic = task({
      id: 101,
      repos: ["sample-alpha", "sample-beta"],
      tags: ["type:epic"],
    });
    const child = task({ id: 102, parent: 101 });
    router.update([epic, child]);

    expect(router.route(child)).toEqual({
      repositoryNames: ["sample-alpha", "sample-beta"],
      repositories: [
        {
          name: "sample-alpha",
          repositoryRoot: "/workspaces/tools/sample-alpha",
        },
        {
          name: "sample-beta",
          repositoryRoot: "/workspaces/tools/sample-beta",
        },
      ],
    });
  });

  it("rejects repository declarations on epic children", () => {
    const router = new TaskRepositoryRouter("/workspaces");
    const epic = task({
      id: 101,
      repos: ["sample-alpha", "sample-beta"],
      tags: ["type:epic"],
    });
    const child = task({ id: 102, parent: 101, repos: ["sample-alpha"] });
    router.update([epic, child]);

    expect(() => router.route(child)).toThrow(
      expect.objectContaining<TaskRoutingAttentionError>({
        code: "child-repository-scope-declared",
      }),
    );
  });

  it("rejects a task without repository scope", () => {
    const router = new TaskRepositoryRouter("/workspaces");
    const selected = task({ id: 103 });
    router.update([selected]);

    expect(() => router.route(selected)).toThrow(
      expect.objectContaining<TaskRoutingAttentionError>({
        code: "repository-scope-not-declared",
      }),
    );
  });

  it("rejects a child whose epic repository scope is unavailable", () => {
    const router = new TaskRepositoryRouter("/workspaces");
    const child = task({ id: 104, parent: 999 });
    router.update([child]);

    expect(() => router.route(child)).toThrow(
      expect.objectContaining<TaskRoutingAttentionError>({
        code: "epic-repository-scope-unavailable",
      }),
    );
  });

  it("resolves all repositories by default and one declared repository when requested", () => {
    const router = new TaskRepositoryRouter("/workspaces");
    const selected = task({
      id: 105,
      repos: ["sample-alpha", "sample-beta"],
    });
    router.update([selected]);

    expect(router.repositoriesForStage(selected)).toHaveLength(2);
    expect(router.repositoriesForStage(selected, "sample-beta")).toEqual([
      {
        name: "sample-beta",
        repositoryRoot: "/workspaces/tools/sample-beta",
      },
    ]);
    expect(() =>
      router.repositoriesForStage(selected, "sample-missing"),
    ).toThrow(
      expect.objectContaining<TaskRoutingAttentionError>({
        code: "stage-repository-undeclared",
      }),
    );
  });
});
