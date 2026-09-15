import { describe, expect, it } from "vitest";

import {
  assertModelOffersReasoningEffort,
  isReasoningEffort,
  modelReasoningEffortCapability,
  reasoningEffortOptionSelections,
  ReasoningEffortUnsupportedError,
  wellKnownReasoningEffortOptionIds,
  type ModelOptionDescriptor,
} from "./reasoning-effort.js";

const selectDescriptor = (
  id: string,
  values: readonly string[],
): ModelOptionDescriptor => ({
  id,
  options: values.map((value) => ({ id: value })),
  type: "select",
});

describe("model reasoning effort capability", () => {
  it("reads the option id each driver publishes rather than assuming one", () => {
    expect(
      modelReasoningEffortCapability([
        selectDescriptor("reasoningEffort", ["low", "high"]),
      ]),
    ).toEqual({ offeredValues: ["low", "high"], optionId: "reasoningEffort" });
    expect(
      modelReasoningEffortCapability([
        selectDescriptor("effort", ["low", "max"]),
      ]),
    ).toEqual({ offeredValues: ["low", "max"], optionId: "effort" });
  });

  it("covers every well-known option id", () => {
    for (const optionId of wellKnownReasoningEffortOptionIds) {
      expect(
        modelReasoningEffortCapability([selectDescriptor(optionId, ["low"])])
          ?.optionId,
      ).toBe(optionId);
    }
  });

  it("prefers the first well-known id when a model publishes several", () => {
    expect(
      modelReasoningEffortCapability([
        selectDescriptor("effort", ["max"]),
        selectDescriptor("reasoningEffort", ["high"]),
      ])?.optionId,
    ).toBe("reasoningEffort");
  });

  it("ignores an option that is not a select and a model with no options", () => {
    expect(
      modelReasoningEffortCapability([
        { id: "reasoningEffort", type: "boolean" },
      ]),
    ).toBeUndefined();
    expect(modelReasoningEffortCapability(undefined)).toBeUndefined();
    expect(modelReasoningEffortCapability([])).toBeUndefined();
  });
});

describe("reasoning effort rejection", () => {
  it("names the model and the values it offers", () => {
    expect(() =>
      assertModelOffersReasoningEffort({
        modelSlug: "sample-model",
        optionDescriptors: [
          selectDescriptor("reasoningEffort", ["low", "medium", "high"]),
        ],
        origin: "providerAliases.primary",
        reasoningEffort: "ultra",
      }),
    ).toThrow(
      "providerAliases.primary sets reasoning effort 'ultra', but model 'sample-model' offers 'low', 'medium', 'high'",
    );
  });

  it("names the model when it offers no reasoning effort at all", () => {
    expect(() =>
      assertModelOffersReasoningEffort({
        modelSlug: "plain-model",
        optionDescriptors: [],
        origin: "Stage 'review'",
        reasoningEffort: "high",
      }),
    ).toThrow(
      "Stage 'review' sets reasoning effort 'high', but model 'plain-model' offers no reasoning effort option",
    );
  });

  it("names the select options a model with an unknown vocabulary publishes", () => {
    expect(() =>
      assertModelOffersReasoningEffort({
        modelSlug: "new-driver-model",
        optionDescriptors: [
          selectDescriptor("thinkingBudget", ["small", "large"]),
          { id: "fastMode", type: "boolean" },
        ],
        origin: "providerAliases.primary",
        reasoningEffort: "large",
      }),
    ).toThrow(
      "offers no reasoning effort option; it publishes select options 'thinkingBudget', and this build reads reasoning effort from 'reasoningEffort' or 'effort'",
    );
  });

  it("says so when a model publishes no select options at all", () => {
    expect(() =>
      assertModelOffersReasoningEffort({
        modelSlug: "plain-model",
        optionDescriptors: [],
        origin: "providerAliases.primary",
        reasoningEffort: "high",
      }),
    ).toThrow("it publishes no select options");
  });

  it("rejects with a recognisable error type", () => {
    expect(() =>
      assertModelOffersReasoningEffort({
        modelSlug: "plain-model",
        optionDescriptors: undefined,
        origin: "session.defaultReasoningEffort",
        reasoningEffort: "high",
      }),
    ).toThrow(ReasoningEffortUnsupportedError);
  });

  it("accepts an offered value and returns the id to dispatch with", () => {
    expect(
      assertModelOffersReasoningEffort({
        modelSlug: "sample-model",
        optionDescriptors: [selectDescriptor("effort", ["low", "max"])],
        origin: "providerAliases.primary",
        reasoningEffort: "max",
      }),
    ).toEqual({ offeredValues: ["low", "max"], optionId: "effort" });
  });
});

describe("reasoning effort option selections", () => {
  it("emits the provider's own id and value", () => {
    expect(reasoningEffortOptionSelections("max", "effort")).toEqual([
      { id: "effort", value: "max" },
    ]);
  });

  it("emits nothing when no layer set an effort", () => {
    expect(reasoningEffortOptionSelections(undefined, "effort")).toEqual([]);
    expect(reasoningEffortOptionSelections("max", undefined)).toEqual([]);
  });
});

describe("reasoning effort scalars", () => {
  it.each([
    ["high", true],
    ["extra-high", true],
    ["", false],
    ["  ", false],
    [" high", false],
    ["high ", false],
    [3, false],
    [undefined, false],
  ])("judges %o", (value, expected) => {
    expect(isReasoningEffort(value)).toBe(expected);
  });
});
