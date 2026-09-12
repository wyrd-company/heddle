// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderSelectionResolver,
  T3ControlPlaneClient,
} from "../control-plane/index.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import { resolveProductionConfiguration } from "./configuration.js";
import {
  CONTROLLED_QUALIFICATION_EXECUTION,
  makeQualificationScratch,
  startIsolatedT3,
  type IsolatedT3,
} from "./driver-qualification.test-support.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const DISPLAY_NAME = CONTROLLED_QUALIFICATION_EXECUTION.displayName;
const INSTANCE_ID = CONTROLLED_QUALIFICATION_EXECUTION.instanceId;

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
      const callerScratch = await makeQualificationScratch();
      teardown.push(callerScratch.cleanup);
      const fixture = await prepareProductionFixture();
      teardown.push(fixture.cleanup);
      const callerHome = join(callerScratch.root, "caller-home");
      const sentinel = join(callerHome, "credential-sentinel");
      await mkdir(callerHome, { recursive: true });
      await writeFile(sentinel, "operator-state-must-not-change\n");

      // No wait between starting T3 and resolving, which is what a service
      // started alongside T3 by the deployment feature actually does.
      const originalHome = process.env["HOME"];
      process.env["HOME"] = callerHome;
      const isolated: IsolatedT3 = await startIsolatedT3({
        binary: t3Binary as string,
        providerInstances: [CONTROLLED_QUALIFICATION_EXECUTION],
        scratch: scratch.root,
      }).finally(() => {
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
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
      const model = "default";

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
      expect(observedStates[0]?.state).toBe("warning");
      expect(observedStates.at(-1)).toEqual({
        installed: true,
        state: "ready",
      });
      expect(catalogReads).toBeGreaterThan(1);
      const providerProcesses = (
        await readFile(isolated.controlledProviderLog, "utf8")
      )
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              home?: string;
              homeSentinelBefore?: string | null;
            },
        );
      expect(providerProcesses.length).toBeGreaterThan(0);
      expect(
        providerProcesses.every(({ home }) => home === isolated.providerHome),
      ).toBe(true);
      expect(
        providerProcesses.every(
          ({ homeSentinelBefore }) =>
            homeSentinelBefore === null ||
            homeSentinelBefore.startsWith("provider-state\n"),
        ),
      ).toBe(true);
      expect(isolated.providerHome).not.toBe(callerHome);
      expect(
        await readFile(
          join(isolated.providerHome, "credential-sentinel"),
          "utf8",
        ),
      ).toContain("controlled-provider-touch\n");
      expect(await readFile(sentinel, "utf8")).toBe(
        "operator-state-must-not-change\n",
      );
    }, 120_000);
  },
);
