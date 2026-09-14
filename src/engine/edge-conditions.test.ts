// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import { EdgeConditionError, EdgeRoutingError } from "./edge-conditions.js";
import { BlueprintValidationError, UnexpectedLandingError } from "./errors.js";
import {
  cleanupFixtures,
  conditionalTerminalBlueprint,
  makeFixture,
  sampleBlueprint,
} from "./lifecycle-engine.test-support.js";
import type { LifecycleBlueprint, LifecycleEffect } from "./types.js";

const attentionMessages = (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  instanceId: string,
): string[] =>
  fixture.persistence
    .replayEvents(instanceId)
    .filter(({ type }) => type === "lifecycle:attention-required")
    .flatMap(({ payload }) => {
      const errors = (payload as { errors?: ErrorDetail[] }).errors;
      return (errors ?? []).flatMap(messages);
    });

type ErrorDetail = { cause?: ErrorDetail | null; message: string };
/** Every message on the cause chain, outermost first. */
const messages = (detail: ErrorDetail): string[] => [
  detail.message,
  ...(detail.cause ? messages(detail.cause) : []),
];

/** The sample with `adjust` split across two guarded edges on the round. */
const guardedAdjust = (
  lowCondition: string,
  highCondition: string,
): LifecycleBlueprint => {
  const blueprint = sampleBlueprint();
  const adjust = blueprint.edges.find(
    ({ disposition }) => disposition === "adjust",
  );
  if (adjust === undefined) throw new Error("adjust edge is missing");
  adjust.condition = lowCondition;
  blueprint.edges.push({
    ...adjust,
    condition: highCondition,
    target: "serve",
  });
  return blueprint;
};

describe("edge conditions", () => {
  afterEach(cleanupFixtures);

  it("routes one disposition across several JSONata-guarded edges", async () => {
    const fixture = await makeFixture(
      guardedAdjust(
        "result.output.dispositions.adjust and result.output.round < 3",
        "result.output.dispositions.adjust and result.output.round >= 3",
      ),
    );
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "guarded",
    });
    for (const round of [1, 2]) {
      const snapshot = await fixture.engine.resume({
        disposition: "adjust",
        instanceId: "guarded",
        operationId: `round-${round}`,
        output: { round },
      });
      expect(snapshot).toMatchObject({
        awaitingNodeIds: ["taste"],
        status: "awaiting",
        validDispositions: ["accept", "adjust"],
      });
    }
    const completed = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "guarded",
      operationId: "round-3",
      output: { round: 3 },
    });
    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "season",
      "season",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("supplies the default condition when a disposition edge omits it", async () => {
    const blueprint = sampleBlueprint();
    for (const edge of blueprint.edges) delete edge.condition;
    const fixture = await makeFixture(blueprint);
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "defaulted",
    });
    const snapshot = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "defaulted",
      operationId: "round-1",
    });
    expect(snapshot).toMatchObject({ awaitingNodeIds: ["taste"] });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "season",
    ]);
    fixture.persistence.close();
  });

  it("evaluates only the chosen disposition's edges on resume", async () => {
    // An author condition on the non-chosen disposition that omits the
    // disposition gate is true after any visit; it must not fire its branch.
    const blueprint = sampleBlueprint();
    blueprint.edges[1]!.condition = "lifecycle.visits.taste >= 1";
    const fixture = await makeFixture(blueprint);
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "ungated",
    });
    const snapshot = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "ungated",
      operationId: "accept",
    });
    expect(snapshot).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("ignores a throwing condition on a disposition that was not chosen", async () => {
    const blueprint = sampleBlueprint();
    blueprint.edges[1]!.condition = '$error("boom")';
    const fixture = await makeFixture(blueprint);
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "other-throws",
    });
    const snapshot = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "other-throws",
      operationId: "accept",
    });
    expect(snapshot).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("routes an unconditioned sibling as the else branch of its disposition", async () => {
    // One conditioned edge and one without a condition share `adjust`; the
    // bare edge fires only when no conditioned sibling does.
    const blueprint = guardedAdjust(
      "result.output.dispositions.adjust and result.output.round < 3",
      "",
    );
    delete blueprint.edges.at(-1)!.condition;
    const fixture = await makeFixture(blueprint);
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "else-branch",
    });
    const early = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "else-branch",
      operationId: "round-1",
      output: { round: 1 },
    });
    expect(early).toMatchObject({ awaitingNodeIds: ["taste"] });
    const late = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "else-branch",
      operationId: "round-3",
      output: { round: 3 },
    });
    expect(late).toMatchObject({ awaitingNodeIds: [], status: "completed" });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "season",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("routes hyphenated and keyword-shaped dispositions through the default guard", async () => {
    // `send-back` is not a JSONata path segment and `in` is a JSONata keyword;
    // the default guard looks both up by quoted name.
    const blueprint = sampleBlueprint();
    for (const edge of blueprint.edges) {
      delete edge.condition;
      if (edge.disposition === "adjust") edge.disposition = "send-back";
      if (edge.disposition === "accept") edge.disposition = "in";
    }
    const fixture = await makeFixture(blueprint);
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "quoted",
    });
    const adjusted = await fixture.engine.resume({
      disposition: "send-back",
      instanceId: "quoted",
      operationId: "round-1",
    });
    expect(adjusted).toMatchObject({
      awaitingNodeIds: ["taste"],
      validDispositions: ["in", "send-back"],
    });
    const served = await fixture.engine.resume({
      disposition: "in",
      instanceId: "quoted",
      operationId: "round-2",
    });
    expect(served).toMatchObject({ awaitingNodeIds: [], status: "completed" });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "season",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("rejects only a blank disposition", async () => {
    const blueprint = sampleBlueprint();
    blueprint.edges[1]!.disposition = " ";
    const fixture = await makeFixture(blueprint);
    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "blank",
      }),
    ).rejects.toThrow('Node "taste" has an invalid disposition');
    fixture.persistence.close();
  });

  it("fails closed with attention when a disposition matches no edge", async () => {
    const fixture = await makeFixture(
      guardedAdjust(
        "result.output.dispositions.adjust and result.output.round > 10",
        "result.output.dispositions.adjust and result.output.round > 20",
      ),
    );
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "unmatched",
    });
    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "unmatched",
        operationId: "round-1",
        output: { round: 1 },
      }),
    ).rejects.toThrow(EdgeRoutingError);
    expect(attentionMessages(fixture, "unmatched")).toEqual([
      'Disposition "adjust" from node "taste" matched no edge condition',
    ]);
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual(["mix"]);
    fixture.persistence.close();
  });

  it("accepts a corrected resume after a routing failure", async () => {
    const fixture = await makeFixture(
      guardedAdjust(
        "result.output.dispositions.adjust and result.output.round > 10",
        "result.output.dispositions.adjust and result.output.round > 20",
      ),
    );
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "recovered",
    });
    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "recovered",
        operationId: "round-1",
        output: { round: 1 },
      }),
    ).rejects.toThrow(EdgeRoutingError);
    const corrected = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "recovered",
      operationId: "round-2",
      output: { round: 11 },
    });
    expect(corrected).toMatchObject({
      awaitingNodeIds: ["taste"],
      status: "awaiting",
    });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "season",
    ]);
    fixture.persistence.close();
  });

  it("fails closed with attention when a disposition matches several edges", async () => {
    const fixture = await makeFixture(
      guardedAdjust(
        "result.output.dispositions.adjust and result.output.round > 0",
        "result.output.dispositions.adjust and result.output.round > -1",
      ),
    );
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "ambiguous",
    });
    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "ambiguous",
        operationId: "round-1",
        output: { round: 1 },
      }),
    ).rejects.toThrow(/matched more than one edge/);
    expect(attentionMessages(fixture, "ambiguous")).toEqual([
      'Disposition "adjust" from node "taste" matched more than one edge: taste->season (adjust), taste->serve (adjust)',
    ]);
    fixture.persistence.close();
  });

  it("names the edge when a resume condition fails to evaluate", async () => {
    const blueprint = sampleBlueprint();
    blueprint.edges[1]!.condition = '$error("boom")';
    const fixture = await makeFixture(blueprint);
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "throwing",
    });
    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "throwing",
        operationId: "round-1",
      }),
    ).rejects.toThrow(EdgeConditionError);
    expect(attentionMessages(fixture, "throwing")).toContain(
      'Edge taste->season (adjust) condition "$error(\\"boom\\")" failed to evaluate: boom',
    );
    fixture.persistence.close();
  });

  it("evaluates JSONata on the edges of a mechanical node", async () => {
    const blueprint = conditionalTerminalBlueprint();
    const leftEdge = blueprint.edges.find(({ target }) => target === "left");
    const rightEdge = blueprint.edges.find(({ target }) => target === "right");
    if (leftEdge === undefined || rightEdge === undefined) {
      throw new Error("choose edges are missing");
    }
    leftEdge.condition = "$count(result.output.items) > 1";
    rightEdge.condition = "$count(result.output.items) <= 1";
    const effects = (items: string[]): Record<string, LifecycleEffect> => ({
      choose: async () => ({ items }),
      left: async () => ({ effect: "left" }),
      mix: async () => ({ effect: "mix" }),
      right: async () => ({ effect: "right" }),
      season: async () => ({ effect: "season" }),
    });
    const many = await makeFixture(blueprint, effects(["a", "b"]));
    const manyRun: string[] = [];
    many.engine["effects"] = Object.fromEntries(
      Object.entries(effects(["a", "b"])).map(([name, effect]) => [
        name,
        (async (input) => {
          manyRun.push(name);
          return effect(input);
        }) as LifecycleEffect,
      ]),
    );
    await many.engine.start({
      blueprintPath: many.blueprintPath,
      instanceId: "many",
    });
    await many.engine.resume({
      disposition: "accept",
      instanceId: "many",
      operationId: "accept",
    });
    expect(manyRun).toEqual(["mix", "choose", "left"]);
    many.persistence.close();
  });

  it("fails closed when a mechanical node condition throws", async () => {
    const blueprint = conditionalTerminalBlueprint();
    const leftEdge = blueprint.edges.find(({ target }) => target === "left");
    if (leftEdge === undefined) throw new Error("left edge is missing");
    leftEdge.condition = '$error("choose failed")';
    const fixture = await makeFixture(blueprint, {
      choose: async () => ({ items: [] }),
      left: async () => ({ effect: "left" }),
      mix: async () => ({ effect: "mix" }),
      right: async () => ({ effect: "right" }),
      season: async () => ({ effect: "season" }),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "mechanical-throw",
    });
    await expect(
      fixture.engine.resume({
        disposition: "accept",
        instanceId: "mechanical-throw",
        operationId: "accept",
      }),
    ).rejects.toThrow(UnexpectedLandingError);
    expect(attentionMessages(fixture, "mechanical-throw")).toContain(
      'Edge choose->left condition "$error(\\"choose failed\\")" failed to evaluate: choose failed',
    );
    fixture.persistence.close();
  });

  it("rejects a condition that does not compile at validation", async () => {
    const blueprint = conditionalTerminalBlueprint();
    blueprint.edges.at(-1)!.condition = "result.output.right and (";
    const fixture = await makeFixture(blueprint, {
      choose: async () => ({}),
      left: async () => ({}),
      mix: async () => ({}),
      right: async () => ({}),
      season: async () => ({}),
    });
    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "broken",
      }),
    ).rejects.toThrow(
      /Edge choose->right condition "result.output.right and \(" does not compile/,
    );
    fixture.persistence.close();
  });

  it("rejects edges of one disposition that disagree or both omit a condition", async () => {
    const disagreeing = guardedAdjust(
      "result.output.dispositions.adjust and result.output.round < 3",
      "result.output.dispositions.adjust and result.output.round >= 3",
    );
    disagreeing.edges.at(-1)!.description = "Something else";
    const disagreeingFixture = await makeFixture(disagreeing);
    await expect(
      disagreeingFixture.engine.start({
        blueprintPath: disagreeingFixture.blueprintPath,
        instanceId: "disagreeing",
      }),
    ).rejects.toThrow(BlueprintValidationError);
    await expect(
      disagreeingFixture.engine.start({
        blueprintPath: disagreeingFixture.blueprintPath,
        instanceId: "disagreeing",
      }),
    ).rejects.toThrow(/disagree on description or output contract/);
    disagreeingFixture.persistence.close();

    const unguarded = sampleBlueprint();
    const adjust = unguarded.edges.find(
      ({ disposition }) => disposition === "adjust",
    )!;
    delete adjust.condition;
    unguarded.edges.push({ ...adjust, target: "serve" });
    const unguardedFixture = await makeFixture(unguarded);
    await expect(
      unguardedFixture.engine.start({
        blueprintPath: unguardedFixture.blueprintPath,
        instanceId: "unguarded",
      }),
    ).rejects.toThrow(/has more than one edge without a condition/);
    unguardedFixture.persistence.close();
  });
});
