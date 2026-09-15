// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  ProviderSelectionError,
  ProviderSelectionResolver,
  type ProviderAliasCatalog,
  type T3ProviderCatalog,
} from "../control-plane/index.js";
import {
  bindResolvedSession,
  modelSelectionFromBinding,
} from "./session-binding.js";
import { resolveStageSessionSelection } from "./stage-session-selection.js";
import type { ResolvedProductionSessionConfiguration } from "./configuration.js";

/**
 * The model publishes the Codex-style option id; the second provider publishes
 * the Claude-style one, so the layered cases below are proved against both
 * vocabularies rather than one assumed id.
 */
const catalog = (): T3ProviderCatalog => [
  {
    availability: "available",
    displayName: "Workbench Alpha",
    driverKind: "sample-driver",
    enabled: true,
    installed: true,
    instanceId: "instance-alpha",
    models: [
      {
        isCustom: false,
        name: "Model Alpha",
        optionDescriptors: [
          {
            id: "reasoningEffort",
            options: [
              { id: "low" },
              { id: "medium" },
              { id: "high" },
              { id: "xhigh" },
            ],
            type: "select",
          },
        ],
        slug: "model-alpha",
      },
    ],
    observedCliVersion: "1.2.3",
    state: "ready",
  },
  {
    availability: "available",
    displayName: "Workbench Beta",
    driverKind: "other-driver",
    enabled: true,
    installed: true,
    instanceId: "instance-beta",
    models: [
      {
        isCustom: false,
        name: "Model Beta",
        optionDescriptors: [
          {
            id: "effort",
            options: [{ id: "low" }, { id: "max" }],
            type: "select",
          },
        ],
        slug: "model-beta",
      },
      { isCustom: false, name: "Plain Model", slug: "plain-model" },
    ],
    observedCliVersion: null,
    state: "ready",
  },
];

const aliasCatalog = (reasoningEffort?: string): ProviderAliasCatalog => ({
  primary: {
    model: "model-alpha",
    providerDisplayName: "Workbench Alpha",
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  },
  reviewer: {
    model: "model-beta",
    providerDisplayName: "Workbench Beta",
  },
  plain: {
    model: "plain-model",
    providerDisplayName: "Workbench Beta",
  },
});

const resolveLayers = async (layers: {
  aliasReasoningEffort?: string;
  defaultReasoningEffort?: string;
  stageReasoningEffort?: string;
}) => {
  const resolver = new ProviderSelectionResolver(
    aliasCatalog(layers.aliasReasoningEffort),
    { readProviderCatalog: async () => catalog() },
    layers.defaultReasoningEffort === undefined
      ? {}
      : { defaultReasoningEffort: layers.defaultReasoningEffort },
  );
  const session = {
    baseRef: "main",
    defaultProviderAlias: "primary",
    defaultRuntimeMode: "auto",
    interactionMode: "default",
  } as unknown as ResolvedProductionSessionConfiguration;
  return resolveStageSessionSelection(
    {
      session,
      stageId: "implement",
      ...(layers.stageReasoningEffort === undefined
        ? {}
        : { stageReasoningEffort: layers.stageReasoningEffort }),
      taskId: 1,
    },
    resolver,
  );
};

describe("layered reasoning effort resolution", () => {
  it("lets the stage win when every layer sets a different value", async () => {
    // The blueprint header layer reaches selection as the stage's effort when
    // the stage sets none; here the stage sets its own, so it is the value.
    const selection = await resolveLayers({
      aliasReasoningEffort: "medium",
      defaultReasoningEffort: "low",
      stageReasoningEffort: "xhigh",
    });

    expect(selection.reasoningEffort).toBe("xhigh");
    expect(selection.reasoningEffortOptionId).toBe("reasoningEffort");
  });

  it("lets the alias candidate win over the configuration default", async () => {
    const selection = await resolveLayers({
      aliasReasoningEffort: "medium",
      defaultReasoningEffort: "low",
    });

    expect(selection.reasoningEffort).toBe("medium");
  });

  it("applies the configuration default when no narrower layer sets one", async () => {
    const selection = await resolveLayers({ defaultReasoningEffort: "low" });

    expect(selection.reasoningEffort).toBe("low");
    expect(selection.reasoningEffortOptionId).toBe("reasoningEffort");
  });

  it("resolves no effort at all when no layer sets one", async () => {
    const selection = await resolveLayers({});

    expect(selection).not.toHaveProperty("reasoningEffort");
    expect(selection).not.toHaveProperty("reasoningEffortOptionId");
  });

  it("carries the option id the selected model publishes", async () => {
    const resolver = new ProviderSelectionResolver(
      aliasCatalog(),
      { readProviderCatalog: async () => catalog() },
      { defaultReasoningEffort: "max" },
    );

    const selection = await resolver.resolve("reviewer", {
      interactionMode: "default",
      runtimeMode: "auto",
    });

    expect(selection.reasoningEffortOptionId).toBe("effort");
    expect(selection.reasoningEffort).toBe("max");
  });
});

describe("reasoning effort candidate fallback", () => {
  /**
   * A stage or header effort must make one candidate unusable, not the stage.
   * The alias layer already skips such a candidate, so both layers answer the
   * same provider-reasoning-effort-unsupported reason the same way.
   */
  const fallbackResolver = () =>
    new ProviderSelectionResolver(
      {
        primary: [
          { model: "model-alpha", providerDisplayName: "Workbench Alpha" },
          { model: "plain-model", providerDisplayName: "Workbench Beta" },
        ],
      },
      { readProviderCatalog: async () => catalog() },
    );

  it("skips a candidate whose model does not offer the stage effort", async () => {
    const session = {
      baseRef: "main",
      defaultProviderAlias: "primary",
      defaultRuntimeMode: "auto",
      interactionMode: "default",
    } as unknown as ResolvedProductionSessionConfiguration;

    const selection = await resolveStageSessionSelection(
      {
        session,
        stageId: "implement",
        stageReasoningEffort: "high",
        taskId: 1,
      },
      fallbackResolver(),
    );

    expect(selection.model.slug).toBe("model-alpha");
    expect(selection.reasoningEffort).toBe("high");
    expect(selection.candidatePosition).toBe(1);
  });

  it("skips a first candidate the stage effort rules out and records it", async () => {
    const session = {
      baseRef: "main",
      defaultProviderAlias: "reversed",
      defaultRuntimeMode: "auto",
      interactionMode: "default",
    } as unknown as ResolvedProductionSessionConfiguration;
    const resolver = new ProviderSelectionResolver(
      {
        reversed: [
          { model: "plain-model", providerDisplayName: "Workbench Beta" },
          { model: "model-alpha", providerDisplayName: "Workbench Alpha" },
        ],
      },
      { readProviderCatalog: async () => catalog() },
    );

    const selection = await resolveStageSessionSelection(
      {
        session,
        stageId: "implement",
        stageReasoningEffort: "high",
        taskId: 1,
      },
      resolver,
    );

    expect(selection.model.slug).toBe("model-alpha");
    expect(selection.candidatePosition).toBe(2);
    expect(selection.skippedCandidates).toEqual([
      expect.objectContaining({
        candidatePosition: 1,
        modelSlug: "plain-model",
        failure: expect.objectContaining({
          message: expect.stringContaining("offers no reasoning effort option"),
        }),
      }),
    ]);
  });

  it("fails the stage only when no candidate offers the stage effort", async () => {
    const session = {
      baseRef: "main",
      defaultProviderAlias: "plainOnly",
      defaultRuntimeMode: "auto",
      interactionMode: "default",
    } as unknown as ResolvedProductionSessionConfiguration;
    const resolver = new ProviderSelectionResolver(
      {
        plainOnly: {
          model: "plain-model",
          providerDisplayName: "Workbench Beta",
        },
      },
      { readProviderCatalog: async () => catalog() },
    );

    await expect(
      resolveStageSessionSelection(
        {
          session,
          stageId: "implement",
          stageReasoningEffort: "high",
          taskId: 1,
        },
        resolver,
      ),
    ).rejects.toThrow("offers no reasoning effort option");
  });
});

describe("unsupported reasoning effort rejection", () => {
  it("rejects a configuration default the model does not offer, naming both", async () => {
    const resolver = new ProviderSelectionResolver(
      {
        primary: {
          model: "model-alpha",
          providerDisplayName: "Workbench Alpha",
        },
      },
      { readProviderCatalog: async () => catalog() },
      { defaultReasoningEffort: "ultra" },
    );

    const startup = resolver.resolveStartup({
      defaultAlias: "primary",
      interactionMode: "default",
      providerBudgets: {},
      runtimeMode: "auto",
    });

    await expect(startup).rejects.toThrow(
      "session.defaultReasoningEffort sets reasoning effort 'ultra', but model 'model-alpha' offers 'low', 'medium', 'high', 'xhigh'",
    );
    await expect(startup).rejects.toMatchObject({
      reason: "provider-reasoning-effort-unsupported",
    });
  });

  it("rejects an alias candidate effort the model does not offer", async () => {
    const resolver = new ProviderSelectionResolver(aliasCatalog("ultra"), {
      readProviderCatalog: async () => catalog(),
    });

    await expect(
      resolver.resolve("primary", {
        interactionMode: "default",
        runtimeMode: "auto",
      }),
    ).rejects.toBeInstanceOf(ProviderSelectionError);
  });

  it("rejects a stage effort the model does not offer, naming the stage", async () => {
    await expect(
      resolveLayers({ stageReasoningEffort: "ultra" }),
    ).rejects.toThrow(
      "Stage 'implement' sets reasoning effort 'ultra', but model 'model-alpha' offers 'low', 'medium', 'high', 'xhigh'",
    );
    await expect(
      resolveLayers({ stageReasoningEffort: "ultra" }),
    ).rejects.toMatchObject({
      reason: "provider-reasoning-effort-unsupported",
    });
  });

  it("rejects any effort for a model that offers none", async () => {
    const resolver = new ProviderSelectionResolver(
      aliasCatalog(),
      { readProviderCatalog: async () => catalog() },
      { defaultReasoningEffort: "low" },
    );

    await expect(
      resolver.resolve("plain", {
        interactionMode: "default",
        runtimeMode: "auto",
      }),
    ).rejects.toThrow("model 'plain-model' offers no reasoning effort option");
  });
});

describe("reasoning effort on the session binding", () => {
  it("reaches the dispatched model selection as a provider option", async () => {
    const selection = await resolveLayers({ stageReasoningEffort: "high" });
    const binding = bindResolvedSession(selection, "session-key", "thread-id");

    expect(binding.reasoningEffort).toBe("high");
    expect(binding.reasoningEffortOptionId).toBe("reasoningEffort");
    expect(modelSelectionFromBinding(binding)).toEqual({
      instanceId: "instance-alpha",
      model: "model-alpha",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("dispatches no options key when no layer set an effort", async () => {
    const selection = await resolveLayers({});
    const binding = bindResolvedSession(selection, "session-key", "thread-id");

    expect(binding).not.toHaveProperty("reasoningEffort");
    expect(modelSelectionFromBinding(binding)).toEqual({
      instanceId: "instance-alpha",
      model: "model-alpha",
    });
  });
});
