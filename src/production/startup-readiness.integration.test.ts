// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderSelectionResolver,
  T3ControlPlaneClient,
} from "../control-plane/index.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import { resolveProductionConfiguration } from "./configuration.js";
import {
  makeQualificationScratch,
  PREFERRED_MODEL_SLUGS,
  startIsolatedT3,
  type IsolatedT3,
} from "./driver-qualification.test-support.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const operatorHome = process.env["HOME"] ?? "";

const DISPLAY_NAME = "Workbench Alpha";
const INSTANCE_ID = "codex-execution";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Unconditional, so a mutation that fails an assertion cannot leak a real
  // T3 process or scratch directory into later tests.
  const pending = teardown.splice(0, teardown.length).reverse();
  for (const release of pending) await release();
});

describe.skipIf(!t3Binary)(
  "startup provider readiness against a real T3",
  () => {
    it("resolves aliases against a T3 whose discovery has not settled", async () => {
      const scratch = await makeQualificationScratch();
      teardown.push(scratch.cleanup);
      const fixture = await prepareProductionFixture();
      teardown.push(fixture.cleanup);

      // No wait between starting T3 and resolving, which is what a service
      // started alongside T3 by the deployment feature actually does.
      const isolated: IsolatedT3 = await startIsolatedT3({
        binary: t3Binary as string,
        home: operatorHome,
        providerInstances: [
          {
            displayName: DISPLAY_NAME,
            driver: "codex",
            instanceId: INSTANCE_ID,
          },
        ],
        scratch: scratch.root,
      });
      teardown.push(isolated.stop);

      const client = new T3ControlPlaneClient({
        accessToken: isolated.accessToken,
        baseUrl: isolated.baseUrl,
      });

      let catalogReads = 0;
      const observedStates: Array<{
        installed: boolean | undefined;
        state: string | undefined;
      }> = [];
      const catalogReader = {
        readProviderCatalog: async () => {
          catalogReads += 1;
          const catalog = await client.readProviderCatalog();
          const entry = catalog.find((row) => row.instanceId === INSTANCE_ID);
          observedStates.push({
            installed: entry?.installed,
            state: entry?.state,
          });
          return catalog;
        },
      };
      const model = PREFERRED_MODEL_SLUGS[INSTANCE_ID];
      if (model === undefined) {
        throw new Error(
          `No qualification model is configured for ${INSTANCE_ID}`,
        );
      }

      const resolver = new ProviderSelectionResolver(
        {
          primary: {
            model,
            providerDisplayName: DISPLAY_NAME,
          },
        },
        catalogReader,
      );

      const resolved = await resolveProductionConfiguration(
        {
          ...fixture.configuration,
          providerAliases: {
            primary: {
              model,
              providerDisplayName: DISPLAY_NAME,
            },
          },
        },
        resolver,
      );

      expect(resolved.session.defaultSelection.providerInstanceId).toBe(
        INSTANCE_ID,
      );
      expect(resolved.session.defaultSelection.providerDisplayName).toBe(
        DISPLAY_NAME,
      );
      expect(resolved.session.defaultSelection.observedCliVersion).toMatch(
        /^\d+\.\d+\.\d+/,
      );
      expect(observedStates[0]).toEqual({ installed: false, state: "warning" });
      expect(observedStates.at(-1)).toEqual({
        installed: true,
        state: "ready",
      });
      expect(catalogReads).toBeGreaterThan(1);
    }, 120_000);
  },
);
