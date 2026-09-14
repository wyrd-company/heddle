// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import { EdgeRoutingError } from "./edge-conditions.js";
import { BlueprintValidationError, InvalidDispositionError } from "./errors.js";
import {
  cleanupFixtures,
  makeFixture,
} from "./lifecycle-engine.test-support.js";
import type { LifecycleBlueprint, LifecycleEffect } from "./types.js";

/** mix → ask (question) → serve when confirmed, discard otherwise. */
const questionBlueprint = (): LifecycleBlueprint => ({
  id: "sample-question",
  nodes: [
    { id: "mix", uses: "mix" },
    {
      id: "ask",
      params: {
        questions: [
          {
            id: "confirm",
            options: [{ label: "yes" }, { label: "no" }],
            question: "Serve the sample?",
          },
        ],
        role: "operator",
      },
      uses: "question",
    },
    { id: "serve", uses: "serve" },
    { id: "discard", uses: "discard" },
  ],
  edges: [
    { source: "mix", target: "ask" },
    {
      condition: "result.output.selected.confirm.yes",
      source: "ask",
      target: "serve",
    },
    {
      condition: "result.output.selected.confirm.no",
      source: "ask",
      target: "discard",
    },
  ],
});

const effects = (run: string[]): Record<string, LifecycleEffect> => ({
  discard: async () => {
    run.push("discard");
    return { effect: "discard" };
  },
  mix: async () => {
    run.push("mix");
    return { effect: "mix" };
  },
  serve: async () => {
    run.push("serve");
    return { effect: "serve" };
  },
});

const answer = (label: "yes" | "no") => ({
  answeredBy: { kind: "operator" },
  answers: {
    confirm: {
      reasoning: "Sample reasoning",
      selectedOptions: [label],
      text: "",
    },
  },
  selected: { confirm: { [label]: true } },
});

describe("question node", () => {
  afterEach(cleanupFixtures);

  it("waits at the question and routes on the answer", async () => {
    const run: string[] = [];
    const fixture = await makeFixture(questionBlueprint(), effects(run));
    const started = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "asked",
    });
    expect(started).toMatchObject({
      awaitingNodeIds: ["ask"],
      status: "awaiting",
      validDispositions: ["answered"],
    });
    await expect(fixture.engine.awaitingNode("asked")).resolves.toMatchObject({
      id: "ask",
      params: { role: "operator" },
      uses: "question",
    });

    const completed = await fixture.engine.resume({
      disposition: "answered",
      instanceId: "asked",
      operationId: "ask:1",
      output: answer("yes"),
    });
    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(run).toEqual(["mix", "serve"]);
    fixture.persistence.close();
  });

  it("routes the other answer to the other edge", async () => {
    const run: string[] = [];
    const fixture = await makeFixture(questionBlueprint(), effects(run));
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "declined",
    });
    await fixture.engine.resume({
      disposition: "answered",
      instanceId: "declined",
      operationId: "ask:1",
      output: answer("no"),
    });
    expect(run).toEqual(["mix", "discard"]);
    fixture.persistence.close();
  });

  it("accepts only the answered disposition", async () => {
    const fixture = await makeFixture(questionBlueprint(), effects([]));
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "wrong",
    });
    await expect(
      fixture.engine.resume({
        disposition: "yes",
        instanceId: "wrong",
        operationId: "ask:1",
        output: answer("yes"),
      }),
    ).rejects.toThrow(InvalidDispositionError);
    fixture.persistence.close();
  });

  it("fails closed when an answer matches no edge", async () => {
    const fixture = await makeFixture(questionBlueprint(), effects([]));
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "unmatched",
    });
    await expect(
      fixture.engine.resume({
        disposition: "answered",
        instanceId: "unmatched",
        operationId: "ask:1",
        output: { ...answer("yes"), selected: { confirm: { maybe: true } } },
      }),
    ).rejects.toThrow(EdgeRoutingError);
    fixture.persistence.close();
  });

  it("lets one unconditional edge fire for any answer", async () => {
    const blueprint = questionBlueprint();
    blueprint.edges = [
      { source: "mix", target: "ask" },
      { source: "ask", target: "serve" },
    ];
    blueprint.nodes = blueprint.nodes.filter(({ id }) => id !== "discard");
    const run: string[] = [];
    const fixture = await makeFixture(blueprint, effects(run));
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "always",
    });
    await fixture.engine.resume({
      disposition: "answered",
      instanceId: "always",
      operationId: "ask:1",
      output: answer("no"),
    });
    expect(run).toEqual(["mix", "serve"]);
    fixture.persistence.close();
  });

  it.each([
    {
      label: "an unknown role",
      mutate: (blueprint: LifecycleBlueprint) => {
        blueprint.nodes[1]!.params = {
          ...blueprint.nodes[1]!.params,
          role: "parent",
        };
      },
      message: /role must be one of "adjudicator", "operator"/,
    },
    {
      label: "no questions",
      mutate: (blueprint: LifecycleBlueprint) => {
        blueprint.nodes[1]!.params = { questions: [], role: "operator" };
      },
      message: /must ask at least one question/,
    },
    {
      label: "a repeated question id",
      mutate: (blueprint: LifecycleBlueprint) => {
        const questions = blueprint.nodes[1]!.params!["questions"] as unknown[];
        blueprint.nodes[1]!.params = {
          questions: [...questions, ...questions],
          role: "operator",
        };
      },
      message: /repeats question id "confirm"/,
    },
    {
      label: "a disposition on a question edge",
      mutate: (blueprint: LifecycleBlueprint) => {
        blueprint.edges[1]!.disposition = "yes";
      },
      message: /must route on a condition, not a disposition/,
    },
    {
      label: "two unconditional edges",
      mutate: (blueprint: LifecycleBlueprint) => {
        delete blueprint.edges[1]!.condition;
        delete blueprint.edges[2]!.condition;
      },
      message: /more than one edge without a condition/,
    },
  ])("rejects a question node with $label", async ({ message, mutate }) => {
    const blueprint = questionBlueprint();
    mutate(blueprint);
    const fixture = await makeFixture(blueprint, effects([]));
    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "invalid",
      }),
    ).rejects.toThrow(BlueprintValidationError);
    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "invalid",
      }),
    ).rejects.toThrow(message);
    fixture.persistence.close();
  });
});
