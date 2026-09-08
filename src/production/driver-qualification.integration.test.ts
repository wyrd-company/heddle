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
import { createProductionComposition } from "./composition.js";
import { resolveProductionConfiguration } from "./configuration.js";
import {
  makeQualificationScratch,
  startIsolatedT3,
} from "./driver-qualification.test-support.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const operatorHome = process.env["HOME"] ?? "";

const EXECUTION = {
  displayName: "Workbench Alpha",
  driver: "claudeAgent",
  instanceId: "claude-execution",
} as const;
const REVIEW = {
  displayName: "Workbench Beta",
  driver: "claudeAgent",
  instanceId: "claude-review",
} as const;
const SECOND_DRIVER = {
  displayName: "Workbench Gamma",
  driver: "codex",
  instanceId: "codex-execution",
} as const;

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Unconditional, so an assertion failure under mutation cannot leak a real
  // T3 process, a composition holding its workspace, or a scratch directory.
  const pending = teardown.splice(0, teardown.length).reverse();
  for (const release of pending) await release();
});

describe.skipIf(!t3Binary)("driver qualification against production Heddle", () => {
  it("lists aliases through the composition's own resolver and real T3 client", async () => {
    const scratch = await makeQualificationScratch();
    teardown.push(scratch.cleanup);
    const fixture = await prepareProductionFixture();
    teardown.push(fixture.cleanup);

    const isolated = await startIsolatedT3({
      binary: t3Binary as string,
      home: operatorHome,
      providerInstances: [EXECUTION, REVIEW, SECOND_DRIVER],
      scratch: scratch.root,
    });
    teardown.push(isolated.stop);

    const catalogClient = new T3ControlPlaneClient({
      accessToken: isolated.accessToken,
      baseUrl: isolated.baseUrl,
    });
    const models = await (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const catalog = await catalogClient.readProviderCatalog();
        const ready = [EXECUTION, REVIEW, SECOND_DRIVER].every((instance) =>
          catalog.some(
            (row) =>
              row.instanceId === instance.instanceId &&
              row.state === "ready" &&
              row.models.length > 0,
          ),
        );
        if (ready) {
          return new Map(
            catalog.map((row) => [row.instanceId, row.models[0]?.slug ?? ""]),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Isolated T3 never finished provider discovery");
    })();

    const providerAliases = {
      execution: {
        model: models.get(EXECUTION.instanceId) ?? "",
        providerDisplayName: EXECUTION.displayName,
      },
      review: {
        model: models.get(REVIEW.instanceId) ?? "",
        providerDisplayName: REVIEW.displayName,
      },
      secondary: {
        model: models.get(SECOND_DRIVER.instanceId) ?? "",
        providerDisplayName: SECOND_DRIVER.displayName,
      },
    };

    const t3Configuration = {
      accessToken: isolated.accessToken,
      baseUrl: isolated.baseUrl,
    };
    const configuration = await resolveProductionConfiguration(
      {
        ...fixture.configuration,
        providerAliases,
        session: {
          ...fixture.configuration.session,
          defaultProviderAlias: "execution",
        },
        t3: t3Configuration,
      },
      new ProviderSelectionResolver(providerAliases, catalogClient),
    );

    // Neither `t3` nor `providerResolver` is supplied, so the composition
    // constructs the real control-plane client and the real resolver itself.
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration,
      providerUsage: { readProviderUsage: async () => [] },
      workflowMcpEndpoint: `${isolated.baseUrl}/mcp`,
    });
    teardown.push(() => composition.close());

    const listing = await composition.subagents.listProviders();
    const byAlias = new Map(
      listing.aliases.map((entry) => [entry.alias, entry]),
    );

    expect([...byAlias.keys()].sort()).toEqual([
      "execution",
      "review",
      "secondary",
    ]);

    // Two differently named T3 instances of one driver stay distinct.
    expect(byAlias.get("execution")?.providerDisplayName).toBe(
      EXECUTION.displayName,
    );
    expect(byAlias.get("review")?.providerDisplayName).toBe(REVIEW.displayName);
    expect(byAlias.get("execution")?.providerInstanceId).toBe(
      EXECUTION.instanceId,
    );
    expect(byAlias.get("review")?.providerInstanceId).toBe(REVIEW.instanceId);
    expect(byAlias.get("execution")?.driverKind).toBe(EXECUTION.driver);
    expect(byAlias.get("review")?.driverKind).toBe(REVIEW.driver);

    // A second driver resolves alongside them.
    expect(byAlias.get("secondary")?.driverKind).toBe(SECOND_DRIVER.driver);
    expect(byAlias.get("secondary")?.providerInstanceId).toBe(
      SECOND_DRIVER.instanceId,
    );

    // Observed CLI versions are qualification provenance, read from the live
    // catalog rather than configured.
    for (const alias of ["execution", "review", "secondary"]) {
      expect(byAlias.get(alias)?.observedCliVersion).toMatch(/^\d+\.\d+\.\d+/);
    }
  }, 180_000);
});
