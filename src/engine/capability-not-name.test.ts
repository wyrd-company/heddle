// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import { validateBlueprint } from "./blueprint.js";
import {
  cleanupFixtures,
  makeFixture,
} from "./lifecycle-engine.test-support.js";
import type { LifecycleBlueprint, LifecycleEffect } from "./types.js";

/**
 * A node's `uses` selects its behaviour; its id is the author's label. These
 * cases keep a familiar name and change or omit the capability, so that any
 * fallback to the name would surface as the wrong effect running.
 */
const recorder = (names: string[], run: Array<[string, string]>) =>
  Object.fromEntries(
    names.map((name) => [
      name,
      (async ({ nodeId }) => {
        run.push([name, nodeId]);
        return { effect: name };
      }) as LifecycleEffect,
    ]),
  );

describe("capability, not name", () => {
  afterEach(cleanupFixtures);

  it("runs a node named finalize as the wait stage it declares", async () => {
    const run: Array<[string, string]> = [];
    const blueprint: LifecycleBlueprint = {
      id: "sample",
      nodes: [
        { id: "prepare-worktree", uses: "complete" },
        { id: "finalize", uses: "wait" },
        { id: "merge", uses: "complete" },
      ],
      edges: [
        { source: "prepare-worktree", target: "finalize" },
        {
          description: "Wrap up",
          disposition: "wrap",
          source: "finalize",
          target: "merge",
        },
      ],
    };
    const fixture = await makeFixture(
      blueprint,
      recorder(["complete", "finalize", "merge", "prepare-worktree"], run),
    );

    const started = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "named",
    });
    expect(started).toMatchObject({
      awaitingNodeIds: ["finalize"],
      validDispositions: ["wrap"],
    });
    const completed = await fixture.engine.resume({
      disposition: "wrap",
      instanceId: "named",
      operationId: "wrap:1",
    });
    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    // Only the `complete` effect ran, once per node that declares it.
    expect(run).toEqual([
      ["complete", "prepare-worktree"],
      ["complete", "merge"],
    ]);
    fixture.persistence.close();
  });

  it("runs a node named review as the fail primitive it declares", async () => {
    const run: Array<[string, string]> = [];
    const blueprint: LifecycleBlueprint = {
      id: "sample",
      nodes: [
        { id: "begin", uses: "complete" },
        { id: "review", params: { message: "Stopped" }, uses: "fail" },
      ],
      edges: [{ source: "begin", target: "review" }],
    };
    const fixture = await makeFixture(
      blueprint,
      recorder(["complete", "fail"], run),
    );

    const started = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "failing",
    });
    expect(started).toMatchObject({ awaitingNodeIds: [], status: "completed" });
    expect(run).toEqual([
      ["complete", "begin"],
      ["fail", "review"],
    ]);
    fixture.persistence.close();
  });

  it("rejects a node that omits its capability whatever its name", () => {
    const blueprint = {
      id: "sample",
      nodes: [{ id: "begin", uses: "complete" }, { id: "review" }],
      edges: [{ source: "begin", target: "review" }],
    } as unknown as LifecycleBlueprint;

    expect(() =>
      validateBlueprint(blueprint, recorder(["complete", "wait"], [])),
    ).toThrow('Node "review" declares no uses; its id names nothing');
  });

  it("lets several nodes declare one capability", async () => {
    const run: Array<[string, string]> = [];
    const blueprint: LifecycleBlueprint = {
      id: "sample",
      nodes: [
        { id: "begin", uses: "complete" },
        { id: "first-check", uses: "wait" },
        { id: "second-check", uses: "wait" },
        { id: "end", uses: "complete" },
      ],
      edges: [
        { source: "begin", target: "first-check" },
        {
          description: "Pass the first check",
          disposition: "pass",
          source: "first-check",
          target: "second-check",
        },
        {
          description: "Pass the second check",
          disposition: "pass",
          source: "second-check",
          target: "end",
        },
      ],
    };
    const fixture = await makeFixture(blueprint, recorder(["complete"], run));

    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "checked",
    });
    await expect(fixture.engine.awaitingNode("checked")).resolves.toMatchObject(
      { id: "first-check", uses: "wait" },
    );
    await fixture.engine.resume({
      disposition: "pass",
      instanceId: "checked",
      operationId: "first-check:1",
    });
    await expect(fixture.engine.awaitingNode("checked")).resolves.toMatchObject(
      { id: "second-check", uses: "wait" },
    );
    const completed = await fixture.engine.resume({
      disposition: "pass",
      instanceId: "checked",
      operationId: "second-check:1",
    });
    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(run).toEqual([
      ["complete", "begin"],
      ["complete", "end"],
    ]);
    fixture.persistence.close();
  });
});
