import { describe, expect, it } from "vitest";
import { createPull } from "./pull.js";
import { nodeId } from "../refs.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import { NameCache } from "../cache.js";
import { createExecute } from "../transport/execute.js";

describe("Pull handle (scripted)", () => {
  it("loads pull request data", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        PullLoad: () => ({
          repository: {
            pullRequest: {
              __typename: "PullRequest",
              id: "PR_123",
              number: 1,
              title: "Test PR",
              body: "Test",
              state: "OPEN",
              isDraft: false,
              headRefName: "feature",
              baseRefName: "main",
              milestone: null,
              labels: { nodes: [] },
              assignees: { nodes: [] },
              reviewDecision: null,
              reviewRequests: { nodes: [] },
              closingIssuesReferences: { nodes: [] },
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              url: "https://github.com/test/repo/pull/1",
              repository: { owner: { login: "test" }, name: "repo" },
            },
          },
        }),
      },
    });

    const ctx = {
      transport,
      cache: new NameCache(),
      execute: createExecute(transport),
      labelPageSize: 100,
      relationshipPageSize: 100,
    };

    const pr = createPull(ctx, { coords: { owner: "test", repo: "repo", number: 1 } });

    const data = await pr.load();
    expect(data.title).toBe("Test PR");
    expect(data.number).toBe(1);
  });

  it("sets pull request properties", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        PullLoad: () => ({
          repository: {
            pullRequest: {
              __typename: "PullRequest",
              id: "PR_123",
              number: 1,
              title: "Old Title",
              body: "Old",
              state: "OPEN",
              isDraft: false,
              headRefName: "feature",
              baseRefName: "main",
              milestone: null,
              labels: { nodes: [] },
              assignees: { nodes: [] },
              reviewDecision: null,
              reviewRequests: { nodes: [] },
              closingIssuesReferences: { nodes: [] },
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              url: "https://github.com/test/repo/pull/1",
              repository: { owner: { login: "test" }, name: "repo" },
            },
          },
        }),
        UpdatePullRequest: () => ({ updatePullRequest: { pullRequest: { id: "PR_123" } } }),
      },
    });

    const ctx = {
      transport,
      cache: new NameCache(),
      execute: createExecute(transport),
      labelPageSize: 100,
      relationshipPageSize: 100,
    };

    const pr = createPull(ctx, {
      coords: { owner: "test", repo: "repo", number: 1 },
      id: nodeId("PR_123"),
    });

    await pr.set({ title: "New Title" });
    expect(transport.callsTo("UpdatePullRequest")).toHaveLength(1);
  });
});
