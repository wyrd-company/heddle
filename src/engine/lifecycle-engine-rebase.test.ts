// ---
// relationships:
//   verifies: heddle
// ---

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BlueprintValidationError,
  RebaseInstanceNotAwaitingError,
  RebaseTargetNotAwaitableError,
  RebaseTargetNotFoundError,
  TransitionConflictError,
} from "./errors.js";
import { GitBlueprintStore } from "./git-blueprint-store.js";
import {
  cleanupFixtures,
  makeFixture,
  sampleBlueprint,
} from "./lifecycle-engine.test-support.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

describe("LifecycleEngine rebase", () => {
  it("rebases an instance to a named state in the current blueprint version", async () => {
    const fixture = await makeFixture();
    const started = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      initialContext: { retained: "value" },
      instanceId: "sample-a",
    });
    await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "sample-a",
      operationId: "operation-before-rebase",
    });
    const priorEvents = fixture.persistence.replayEvents("sample-a");
    const blueprint = sampleBlueprint();
    blueprint.nodes.push({
      id: "inspect",
      uses: "wait",
      config: { joinStrategy: "any" },
    });
    const openingEdge = blueprint.edges.find(
      ({ source, target }) => source === "mix" && target === "taste",
    );
    if (openingEdge === undefined) throw new Error("opening edge is missing");
    openingEdge.target = "inspect";
    blueprint.edges.push({
      source: "inspect",
      target: "taste",
      disposition: "approve",
      description: "Approve the sample",
      condition: "result.output.dispositions.approve",
    });
    const artifact = { ...blueprint } as Partial<typeof blueprint>;
    delete artifact.id;
    await writeFile(
      join(fixture.repositoryRoot, fixture.blueprintPath),
      JSON.stringify(artifact),
    );

    const rebased = await fixture.engine.rebase({
      instanceId: "sample-a",
      targetState: "inspect",
    });
    expect(rebased).toMatchObject({
      awaitingNodeIds: ["inspect"],
      status: "awaiting",
      validDispositions: ["approve"],
    });
    expect(rebased.blueprintBlobHash).not.toBe(started.blueprintBlobHash);
    const rebaseEvents = fixture.persistence
      .replayEvents("sample-a", priorEvents.at(-1)?.sequence)
      .filter(({ type }) => type === "instance:updated");
    expect(rebaseEvents).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          flowcraftContext: expect.objectContaining({
            awaitingNodeIds: ["inspect"],
            blueprintBlobHash: rebased.blueprintBlobHash,
            status: "awaiting",
          }),
        }),
      }),
    ]);
    const persisted = fixture.persistence.getInstance("sample-a")?.state
      .flowcraftContext as { serializedContext: string };
    expect(JSON.parse(persisted.serializedContext)).toMatchObject({
      _awaitingNodeIds: ["inspect"],
      retained: "value",
    });
    expect(JSON.parse(persisted.serializedContext)).not.toHaveProperty(
      "_outputs.taste",
    );
    expect(JSON.parse(persisted.serializedContext)).not.toHaveProperty(
      "_outputs.season",
    );

    const advanced = await fixture.engine.resume({
      disposition: "approve",
      instanceId: "sample-a",
      operationId: "operation-after-rebase",
    });
    expect(advanced).toMatchObject({
      awaitingNodeIds: ["taste"],
      blueprintBlobHash: rebased.blueprintBlobHash,
      status: "awaiting",
    });

    const completed = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
      operationId: "operation-final",
    });

    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      blueprintBlobHash: rebased.blueprintBlobHash,
      status: "completed",
    });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "season",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("does not overwrite a concurrently changed instance", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const compareAndSwap = fixture.persistence.compareAndSwapInstance.bind(
      fixture.persistence,
    );
    let injectWinner = true;
    fixture.persistence.compareAndSwapInstance = (
      instanceId,
      expectedVersion,
      state,
    ) => {
      if (injectWinner) {
        injectWinner = false;
        const current = fixture.persistence.getInstance(instanceId);
        if (current === undefined) throw new Error("instance is missing");
        fixture.persistence.updateInstance(instanceId, {
          ...current.state,
          correlationTokens: { winner: "token" },
        });
      }
      return compareAndSwap(instanceId, expectedVersion, state);
    };

    await expect(
      fixture.engine.rebase({
        instanceId: "sample-a",
        targetState: "taste",
      }),
    ).rejects.toEqual(new TransitionConflictError("sample-a"));

    expect(fixture.persistence.getInstance("sample-a")?.state).toMatchObject({
      correlationTokens: { winner: "token" },
      flowcraftContext: {
        awaitingNodeIds: ["taste"],
      },
    });
    fixture.persistence.close();
  });

  it("rejects rebase while a lifecycle transition is active", async () => {
    let markEffectStarted: (() => void) | undefined;
    const effectStarted = new Promise<void>((resolve) => {
      markEffectStarted = resolve;
    });
    let releaseEffect: (() => void) | undefined;
    const effectMayFinish = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const fixture = await makeFixture(sampleBlueprint(), {
      mix: async () => ({ effect: "mix" }),
      season: async () => {
        markEffectStarted?.();
        await effectMayFinish;
        return { effect: "season" };
      },
      serve: async () => ({ effect: "serve" }),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const active = fixture.engine.resume({
      disposition: "adjust",
      instanceId: "sample-a",
      operationId: "operation-active",
    });
    await effectStarted;
    const before = fixture.persistence.getInstance("sample-a");

    try {
      await expect(
        fixture.engine.rebase({
          instanceId: "sample-a",
          targetState: "taste",
        }),
      ).rejects.toEqual(new TransitionConflictError("sample-a"));
      expect(fixture.persistence.getInstance("sample-a")).toEqual(before);
    } finally {
      releaseEffect?.();
      await active;
    }
    fixture.persistence.close();
  });

  it("rejects rebase after a lifecycle instance is completed", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
      operationId: "operation-complete",
    });
    const before = fixture.persistence.getInstance("sample-a");
    const invocations = [...fixture.invocations];

    await expect(
      fixture.engine.rebase({
        instanceId: "sample-a",
        targetState: "taste",
      }),
    ).rejects.toEqual(
      new RebaseInstanceNotAwaitingError("sample-a", "completed"),
    );

    expect(fixture.persistence.getInstance("sample-a")).toEqual(before);
    expect(fixture.invocations).toEqual(invocations);
    fixture.persistence.close();
  });

  it("rejects a historical blueprint with a different artifact identity", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const before = fixture.persistence.getInstance("sample-a");
    const read = GitBlueprintStore.prototype.read;
    let reads = 0;
    vi.spyOn(GitBlueprintStore.prototype, "read").mockImplementation(
      async function (blobHash, path) {
        const blueprint = await read.call(this, blobHash, path);
        reads += 1;
        return reads === 1 ? { ...blueprint, id: "other" } : blueprint;
      },
    );

    await expect(
      fixture.engine.rebase({
        instanceId: "sample-a",
        targetState: "taste",
      }),
    ).rejects.toEqual(
      new BlueprintValidationError(
        "Rebase blueprint artifact identity does not match the running instance",
      ),
    );

    expect(fixture.persistence.getInstance("sample-a")).toEqual(before);
    fixture.persistence.close();
  });

  it("raises attention for a missing target state without changing the instance", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const before = fixture.persistence.getInstance("sample-a");

    await expect(
      fixture.engine.rebase({
        instanceId: "sample-a",
        targetState: "missing",
      }),
    ).rejects.toEqual(new RebaseTargetNotFoundError("sample-a", "missing"));
    await expect(
      fixture.engine.rebase({
        instanceId: "sample-a",
        targetState: "missing",
      }),
    ).rejects.toEqual(new RebaseTargetNotFoundError("sample-a", "missing"));

    expect(fixture.persistence.getInstance("sample-a")).toEqual(before);
    expect(
      fixture.persistence
        .replayEvents("sample-a")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          reason: "rebase-target-missing",
          targetState: "missing",
        }),
      }),
    ]);
    fixture.persistence.close();
  });

  it("does not raise stale attention after a concurrent instance change", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const pin = GitBlueprintStore.prototype.pin;
    let markPinStarted: (() => void) | undefined;
    const pinStarted = new Promise<void>((resolve) => {
      markPinStarted = resolve;
    });
    let releasePin: (() => void) | undefined;
    const pinMayFinish = new Promise<void>((resolve) => {
      releasePin = resolve;
    });
    vi.spyOn(GitBlueprintStore.prototype, "pin").mockImplementation(
      async function (path) {
        markPinStarted?.();
        await pinMayFinish;
        return pin.call(this, path);
      },
    );
    const staleRebase = fixture.engine.rebase({
      instanceId: "sample-a",
      targetState: "missing",
    });
    await pinStarted;

    try {
      await fixture.engine.resume({
        disposition: "accept",
        instanceId: "sample-a",
        operationId: "operation-concurrent",
      });
    } finally {
      releasePin?.();
    }

    await expect(staleRebase).rejects.toEqual(
      new TransitionConflictError("sample-a"),
    );
    expect(fixture.persistence.getInstance("sample-a")?.state).toMatchObject({
      flowcraftContext: {
        awaitingNodeIds: [],
        pendingTransition: null,
        status: "completed",
      },
    });
    expect(
      fixture.persistence
        .replayEvents("sample-a")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toEqual([]);
    fixture.persistence.close();
  });

  it("raises attention when a named node is not an awaiting state", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const before = fixture.persistence.getInstance("sample-a");

    await expect(
      fixture.engine.rebase({
        instanceId: "sample-a",
        targetState: "serve",
      }),
    ).rejects.toEqual(new RebaseTargetNotAwaitableError("sample-a", "serve"));

    expect(fixture.persistence.getInstance("sample-a")).toEqual(before);
    expect(
      fixture.persistence
        .replayEvents("sample-a")
        .filter(({ type }) => type === "lifecycle:attention-required")
        .at(-1)?.payload,
    ).toMatchObject({
      reason: "rebase-target-not-awaitable",
      targetState: "serve",
    });
    fixture.persistence.close();
  });
});
