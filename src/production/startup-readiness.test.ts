// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  ProviderSelectionError,
  ProviderSelectionResolver,
  type T3ProviderCatalog,
} from "../control-plane/index.js";
import { resolveProductionConfiguration } from "./configuration.js";
import { prepareProductionFixture } from "./composition.test-support.js";

const DISPLAY_NAME = "Workbench Alpha";
const MODEL_SLUG = "sample-model";

const readyProvider = {
  availability: "available" as const,
  displayName: DISPLAY_NAME,
  driverKind: "codex",
  enabled: true,
  installed: true,
  instanceId: "codex-execution",
  models: [{ isCustom: false, name: "Sample Model", slug: MODEL_SLUG }],
  observedCliVersion: "0.153.4",
  state: "ready",
};

/** A provider T3 has configured but not yet finished discovering. */
const undiscoveredProvider = {
  ...readyProvider,
  installed: false,
  observedCliVersion: null,
  state: "warning",
};

const catalogReader = (
  responses: readonly (T3ProviderCatalog | Error)[],
): { readProviderCatalog: () => Promise<T3ProviderCatalog>; reads: number[] } => {
  const state = { reads: [0] };
  let call = 0;
  return {
    reads: state.reads,
    readProviderCatalog: async () => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      state.reads[0] = call;
      if (response instanceof Error) throw response;
      return response;
    },
  };
};

const configurationWith = async (): Promise<
  Awaited<ReturnType<typeof prepareProductionFixture>>
> => prepareProductionFixture();

const startupConfiguration = (
  fixture: Awaited<ReturnType<typeof prepareProductionFixture>>,
) => ({
  ...fixture.configuration,
  providerAliases: {
    primary: { model: MODEL_SLUG, providerDisplayName: DISPLAY_NAME },
  },
});

describe("startup provider readiness", () => {
  it("waits for a provider T3 has not finished discovering", async () => {
    const fixture = await configurationWith();
    try {
      const reader = catalogReader([
        [undiscoveredProvider],
        [undiscoveredProvider],
        [readyProvider],
      ]);
      const resolver = new ProviderSelectionResolver(
        { primary: { model: MODEL_SLUG, providerDisplayName: DISPLAY_NAME } },
        reader,
      );

      const resolved = await resolveProductionConfiguration(
        startupConfiguration(fixture),
        resolver,
        { pollMilliseconds: 0, sleep: async () => undefined },
      );

      expect(resolved.session.defaultSelection.providerInstanceId).toBe(
        "codex-execution",
      );
      expect(resolved.session.defaultSelection.observedCliVersion).toBe(
        "0.153.4",
      );
      expect(reader.reads[0]).toBe(3);
    } finally {
      await fixture.cleanup();
    }
  });

  it("waits for a T3 whose catalog is not yet reachable", async () => {
    const fixture = await configurationWith();
    try {
      const reader = catalogReader([
        new Error("connection refused"),
        [readyProvider],
      ]);
      const resolver = new ProviderSelectionResolver(
        { primary: { model: MODEL_SLUG, providerDisplayName: DISPLAY_NAME } },
        reader,
      );

      const resolved = await resolveProductionConfiguration(
        startupConfiguration(fixture),
        resolver,
        { pollMilliseconds: 0, sleep: async () => undefined },
      );

      expect(resolved.session.defaultSelection.providerInstanceId).toBe(
        "codex-execution",
      );
      expect(reader.reads[0]).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when the provider never becomes ready", async () => {
    const fixture = await configurationWith();
    try {
      const reader = catalogReader([[undiscoveredProvider]]);
      const resolver = new ProviderSelectionResolver(
        { primary: { model: MODEL_SLUG, providerDisplayName: DISPLAY_NAME } },
        reader,
      );
      let clock = 0;
      // Bound the wait in the test itself. Without this, removing the deadline
      // guard spins a tight await loop that starves the runner's timer, and the
      // mutation hangs instead of failing a named test.
      let sleeps = 0;

      await expect(
        resolveProductionConfiguration(startupConfiguration(fixture), resolver, {
          now: () => {
            clock += 1_000;
            return clock;
          },
          pollMilliseconds: 0,
          sleep: async () => {
            sleeps += 1;
            if (sleeps > 20) {
              throw new Error("startup waited past its deadline");
            }
          },
          timeoutMilliseconds: 5_000,
        }),
      ).rejects.toThrow(
        `T3 provider '${DISPLAY_NAME}' is not available, enabled, installed, and ready`,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not wait out a misconfigured alias that waiting cannot repair", async () => {
    const fixture = await configurationWith();
    try {
      const reader = catalogReader([[readyProvider]]);
      const resolver = new ProviderSelectionResolver(
        {
          primary: {
            model: "model-that-does-not-exist",
            providerDisplayName: DISPLAY_NAME,
          },
        },
        reader,
      );

      await expect(
        resolveProductionConfiguration(startupConfiguration(fixture), resolver, {
          pollMilliseconds: 0,
          sleep: async () => undefined,
        }),
      ).rejects.toThrow(ProviderSelectionError);
      // One read, not a poll loop: the failure is permanent.
      expect(reader.reads[0]).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
