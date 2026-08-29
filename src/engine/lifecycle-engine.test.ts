// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  BlueprintValidationError,
  InvalidDispositionError,
  TransitionConflictError,
  UnexpectedLandingError,
  type LifecycleEffect,
} from "./index.js";
import {
  cleanupFixtures,
  makeFixture,
  sampleBlueprint,
} from "./lifecycle-engine.test-support.js";

const execFileAsync = promisify(execFile);

afterEach(async () => {
  await cleanupFixtures();
});

describe("LifecycleEngine", () => {
  it("starts at a wait node and records the blueprint git blob", async () => {
    const fixture = await makeFixture();

    const snapshot = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      initialContext: { sample: "plain" },
      instanceId: "sample-a",
    });

    expect(snapshot).toMatchObject({
      awaitingNodeIds: ["taste"],
      instanceId: "sample-a",
      status: "awaiting",
      validDispositions: ["accept", "adjust"],
    });
    expect(snapshot.blueprintBlobHash).toMatch(/^[0-9a-f]{40,64}$/);
    expect(
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext,
    ).toMatchObject({
      blueprintBlobHash: snapshot.blueprintBlobHash,
      blueprintPath: fixture.blueprintPath,
      status: "awaiting",
    });
    fixture.persistence.close();
  });

  it("loops through a condition edge more than three times", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    for (let round = 1; round <= 4; round += 1) {
      const snapshot = await fixture.engine.resume({
        disposition: "adjust",
        instanceId: "sample-a",
        output: { round },
      });
      expect(snapshot).toMatchObject({
        awaitingNodeIds: ["taste"],
        status: "awaiting",
      });
    }
    const completed = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
    });

    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
      validDispositions: [],
    });
    expect(
      fixture.invocations.filter(({ effect }) => effect === "season"),
    ).toHaveLength(4);
    fixture.persistence.close();
  });

  it("resumes from the pinned blob after the blueprint file changes", async () => {
    const fixture = await makeFixture();
    const started = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    await writeFile(
      join(fixture.repositoryRoot, fixture.blueprintPath),
      JSON.stringify({ ...sampleBlueprint(), edges: [] }),
    );
    const { stdout: changedHash } = await execFileAsync(
      "git",
      ["hash-object", fixture.blueprintPath],
      { cwd: fixture.repositoryRoot },
    );
    await execFileAsync("git", ["prune", "--expire", "now"], {
      cwd: fixture.repositoryRoot,
    });

    const completed = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
    });

    expect(changedHash.trim()).not.toBe(started.blueprintBlobHash);
    expect(completed.blueprintBlobHash).toBe(started.blueprintBlobHash);
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("retries a pending start with the same normalized blueprint path", async () => {
    let attempts = 0;
    const fixture = await makeFixture(sampleBlueprint(), {
      mix: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("interrupted");
        return { effect: "mix" };
      },
      season: async () => ({ effect: "season" }),
      serve: async () => ({ effect: "serve" }),
    });
    const blueprintPath = `./${fixture.blueprintPath}`;

    await expect(
      fixture.engine.start({ blueprintPath, instanceId: "sample-a" }),
    ).rejects.toThrow(UnexpectedLandingError);
    const recovered = await fixture.engine.start({
      blueprintPath,
      instanceId: "sample-a",
    });

    expect(recovered).toMatchObject({
      awaitingNodeIds: ["taste"],
      blueprintPath: fixture.blueprintPath,
      status: "awaiting",
    });
    expect(attempts).toBe(2);
    fixture.persistence.close();
  });

  it("allows only one concurrent disposition to claim a transition", async () => {
    const applied: string[] = [];
    const record =
      (effect: string): LifecycleEffect =>
      async () => {
        applied.push(effect);
        await delay(10);
        return { effect };
      };
    const fixture = await makeFixture(sampleBlueprint(), {
      mix: record("mix"),
      season: record("season"),
      serve: record("serve"),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    const results = await Promise.allSettled([
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "sample-a",
      }),
      fixture.engine.resume({
        disposition: "accept",
        instanceId: "sample-a",
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(TransitionConflictError),
      status: "rejected",
    });
    expect(applied.slice(1)).toHaveLength(1);
    fixture.persistence.close();
  });

  it("rejects an invalid disposition with the valid set", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const version = fixture.persistence.getInstance("sample-a")?.version;

    await expect(
      fixture.engine.resume({
        disposition: "discard",
        instanceId: "sample-a",
      }),
    ).rejects.toEqual(
      new InvalidDispositionError("discard", ["accept", "adjust"]),
    );
    expect(fixture.persistence.getInstance("sample-a")?.version).toBe(version);
    fixture.persistence.close();
  });

  it("rejects action routing and cycle nodes without joinStrategy any", async () => {
    const actionBlueprint = sampleBlueprint();
    actionBlueprint.edges[1] = {
      ...actionBlueprint.edges[1]!,
      action: "adjust",
    };
    const actionFixture = await makeFixture(actionBlueprint);

    await expect(
      actionFixture.engine.start({
        blueprintPath: actionFixture.blueprintPath,
        instanceId: "sample-a",
      }),
    ).rejects.toThrow(/condition edges, not action edges/);
    actionFixture.persistence.close();

    const conditionBlueprint = sampleBlueprint();
    conditionBlueprint.edges[1] = {
      ...conditionBlueprint.edges[1]!,
      condition: "result.output.adjust",
    };
    const conditionFixture = await makeFixture(conditionBlueprint);
    await expect(
      conditionFixture.engine.start({
        blueprintPath: conditionFixture.blueprintPath,
        instanceId: "sample-condition",
      }),
    ).rejects.toThrow(BlueprintValidationError);
    conditionFixture.persistence.close();

    const joinBlueprint = sampleBlueprint();
    delete joinBlueprint.nodes[2]?.config;
    const joinFixture = await makeFixture(joinBlueprint);
    await expect(
      joinFixture.engine.start({
        blueprintPath: joinFixture.blueprintPath,
        instanceId: "sample-b",
      }),
    ).rejects.toThrow(/season.*joinStrategy.*any/);
    joinFixture.persistence.close();
  });

  it("raises attention when Flowcraft silently completes before the terminal effect", async () => {
    const blueprint = sampleBlueprint();
    blueprint.nodes.push({ id: "gate", uses: "gate" });
    const acceptEdge = blueprint.edges.find(
      ({ disposition }) => disposition === "accept",
    );
    if (acceptEdge === undefined) throw new Error("accept edge is missing");
    acceptEdge.target = "gate";
    blueprint.edges.push({
      source: "gate",
      target: "serve",
      condition: "result.output.continue",
    });
    const fixture = await makeFixture(blueprint, {
      gate: async () => ({ effect: "gate" }),
      mix: async () => ({ effect: "mix" }),
      season: async () => ({ effect: "season" }),
      serve: async () => ({ effect: "serve" }),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    await expect(
      fixture.engine.resume({
        disposition: "accept",
        instanceId: "sample-a",
      }),
    ).rejects.toThrow(UnexpectedLandingError);

    const attention = fixture.persistence
      .replayEvents("sample-a")
      .filter(({ type }) => type === "lifecycle:attention-required");
    expect(attention).toHaveLength(1);
    expect(attention[0]?.payload).toMatchObject({
      actualStatus: "completed",
      expectedTerminalNodeIds: ["serve"],
    });
    expect(
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext,
    ).toMatchObject({
      executionIds: [expect.any(String), expect.any(String)],
      pendingTransition: {
        disposition: "accept",
      },
    });
    fixture.persistence.close();
  });

  it("reuses an effect idempotency key when an interrupted transition retries", async () => {
    const acceptedKeys = new Set<string>();
    let appliedEffects = 0;
    let attempts = 0;
    const fixture = await makeFixture(sampleBlueprint(), {
      mix: async () => ({ effect: "mix" }),
      season: async ({ idempotencyKey }) => {
        attempts += 1;
        if (!acceptedKeys.has(idempotencyKey)) {
          acceptedKeys.add(idempotencyKey);
          appliedEffects += 1;
        }
        if (attempts === 1) throw new Error("interrupted");
        return { effect: "season" };
      },
      serve: async () => ({ effect: "serve" }),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "sample-a",
      }),
    ).rejects.toThrow(UnexpectedLandingError);
    const recovered = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "sample-a",
    });

    expect(recovered.status).toBe("awaiting");
    expect(attempts).toBe(2);
    expect(appliedEffects).toBe(1);
    expect(acceptedKeys.size).toBe(1);
    fixture.persistence.close();
  });
});
