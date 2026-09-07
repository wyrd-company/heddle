// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import {
  ProviderSelectionError,
  ProviderSelectionResolver,
  type T3ProviderCatalog,
} from "./provider-selection.js";

const catalog = (): T3ProviderCatalog => [
  {
    availability: "available",
    displayName: "Workbench Alpha",
    driverKind: "sample-driver",
    enabled: true,
    installed: true,
    instanceId: "instance-alpha",
    models: [
      { isCustom: false, name: "Model Alpha", slug: "model-alpha" },
      { isCustom: true, name: "Custom Model", slug: "custom-model" },
    ],
    observedCliVersion: "1.2.3",
    state: "ready",
  },
  {
    availability: "available",
    displayName: "Workbench Beta",
    driverKind: "sample-driver",
    enabled: true,
    installed: true,
    instanceId: "instance-beta",
    models: [{ isCustom: false, name: "Model Beta", slug: "model-beta" }],
    observedCliVersion: null,
    state: "ready",
  },
];

const aliases = {
  primary: {
    model: "model-alpha",
    providerDisplayName: "Workbench Alpha",
  },
  specialist: {
    model: "custom-model",
    providerDisplayName: "Workbench Alpha",
  },
  reviewer: {
    model: "model-beta",
    providerDisplayName: "Workbench Beta",
  },
};

describe("ProviderSelectionResolver", () => {
  it("keeps provider instance identity separate from a shared driver kind", async () => {
    const readProviderCatalog = vi.fn(async () => catalog());
    const resolver = new ProviderSelectionResolver(aliases, {
      readProviderCatalog,
    });

    await expect(
      resolver.resolve("primary", {
        interactionMode: "default",
        runtimeMode: "full-access",
      }),
    ).resolves.toEqual({
      alias: "primary",
      driverKind: "sample-driver",
      interactionMode: "default",
      model: {
        isCustom: false,
        name: "Model Alpha",
        slug: "model-alpha",
      },
      observedCliVersion: "1.2.3",
      providerDisplayName: "Workbench Alpha",
      providerInstanceId: "instance-alpha",
      runtimeMode: "full-access",
    });
    await expect(
      resolver.resolve("reviewer", {
        interactionMode: "default",
        runtimeMode: "auto",
      }),
    ).resolves.toMatchObject({
      driverKind: "sample-driver",
      observedCliVersion: null,
      providerInstanceId: "instance-beta",
    });
    expect(readProviderCatalog).toHaveBeenCalledTimes(2);
  });

  it("resolves all aliases and collapses equal budgets for aliases on one instance", async () => {
    const resolver = new ProviderSelectionResolver(aliases, {
      readProviderCatalog: async () => catalog(),
    });

    const resolved = await resolver.resolveStartup({
      defaultAlias: "primary",
      interactionMode: "default",
      providerBudgets: {
        primary: { usageLimit: 50 },
        specialist: { usageLimit: 50 },
      },
      runtimeMode: "auto",
    });

    expect([...resolved.aliases]).toEqual([
      [
        "primary",
        expect.objectContaining({ providerInstanceId: "instance-alpha" }),
      ],
      [
        "reviewer",
        expect.objectContaining({ providerInstanceId: "instance-beta" }),
      ],
      [
        "specialist",
        expect.objectContaining({ providerInstanceId: "instance-alpha" }),
      ],
    ]);
    expect(resolved.defaultSelection.alias).toBe("primary");
    expect(resolved.providerBudgets).toEqual({
      "instance-alpha": { usageLimit: 50 },
    });
  });

  it("rejects conflicting budgets for aliases on one provider instance", async () => {
    const resolver = new ProviderSelectionResolver(aliases, {
      readProviderCatalog: async () => catalog(),
    });

    await expect(
      resolver.resolveStartup({
        defaultAlias: "primary",
        interactionMode: "default",
        providerBudgets: {
          primary: { usageLimit: 50 },
          specialist: { usageLimit: 60 },
        },
        runtimeMode: "auto",
      }),
    ).rejects.toThrow(
      "Provider aliases 'primary' and 'specialist' select provider instance 'instance-alpha' with conflicting pacing limits",
    );
  });

  it.each([
    {
      aliases,
      alias: "missing",
      expected: "provider-alias-not-allowed",
    },
    {
      aliases: {
        absent: {
          model: "model-alpha",
          providerDisplayName: "Workbench Missing",
        },
      },
      alias: "absent",
      expected: "provider-name-not-found",
    },
    {
      aliases: {
        primary: {
          model: "missing-model",
          providerDisplayName: "Workbench Alpha",
        },
      },
      alias: "primary",
      expected: "provider-model-not-found",
    },
  ])("reports $expected without selecting a fallback", async (testCase) => {
    const resolver = new ProviderSelectionResolver(testCase.aliases, {
      readProviderCatalog: async () => catalog(),
    });

    const error = await resolver
      .resolve(testCase.alias, {
        interactionMode: "default",
        runtimeMode: "auto",
      })
      .catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(ProviderSelectionError);
    expect((error as ProviderSelectionError).reason).toBe(testCase.expected);
  });

  it("rejects ambiguous names before provider availability or model checks", async () => {
    const resolver = new ProviderSelectionResolver(aliases, {
      readProviderCatalog: async () => [
        catalog()[0]!,
        { ...catalog()[0]!, instanceId: "instance-duplicate" },
      ],
    });

    await expect(
      resolver.resolve("primary", {
        interactionMode: "default",
        runtimeMode: "auto",
      }),
    ).rejects.toMatchObject({ reason: "provider-name-ambiguous" });
  });

  it("matches provider display names and model slugs case-sensitively", async () => {
    const resolver = new ProviderSelectionResolver(
      {
        "wrong-name-case": {
          model: "model-alpha",
          providerDisplayName: "workbench alpha",
        },
        "wrong-model-case": {
          model: "MODEL-ALPHA",
          providerDisplayName: "Workbench Alpha",
        },
      },
      { readProviderCatalog: async () => catalog() },
    );

    await expect(
      resolver.resolve("wrong-name-case", {
        interactionMode: "default",
        runtimeMode: "auto",
      }),
    ).rejects.toMatchObject({ reason: "provider-name-not-found" });
    await expect(
      resolver.resolve("wrong-model-case", {
        interactionMode: "default",
        runtimeMode: "auto",
      }),
    ).rejects.toMatchObject({ reason: "provider-model-not-found" });
  });

  it.each([
    { field: "availability", value: "unavailable" },
    { field: "enabled", value: false },
    { field: "installed", value: false },
    { field: "state", value: "warning" },
  ] as const)(
    "rejects a provider whose $field is not selectable",
    async ({ field, value }) => {
      const provider = { ...catalog()[0]!, [field]: value };
      const resolver = new ProviderSelectionResolver(aliases, {
        readProviderCatalog: async () => [provider],
      });

      await expect(
        resolver.resolve("primary", {
          interactionMode: "default",
          runtimeMode: "auto",
        }),
      ).rejects.toMatchObject({ reason: "provider-unavailable" });
    },
  );

  it("normalizes transport failure to the safe catalog-unavailable reason", async () => {
    const resolver = new ProviderSelectionResolver(aliases, {
      readProviderCatalog: async () => {
        throw new Error("transport included sensitive detail");
      },
    });

    const error = await resolver
      .resolve("primary", {
        interactionMode: "default",
        runtimeMode: "auto",
      })
      .catch((candidate: unknown) => candidate);

    expect(error).toMatchObject({
      message: "T3 provider catalog is unavailable",
      reason: "provider-catalog-unavailable",
    });
    expect(String(error)).not.toContain("sensitive detail");
  });
});
