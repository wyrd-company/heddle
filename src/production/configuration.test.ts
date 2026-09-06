// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  validateProductionConfiguration,
  type ProductionConfiguration,
} from "./configuration.js";

const fixture = (): ProductionConfiguration => ({
  adHocProject: {
    name: "Shared tasks",
    projectId: "shared-project",
    workspaceRoot: "/tmp/sample-workspace",
  },
  boardDirectory: "/tmp/sample-board",
  cadenceMilliseconds: 1_000,
  observationThresholds: {
    endedMilliseconds: 1_000,
    failedMilliseconds: 1_000,
    stalledMilliseconds: 1_000,
  },
  pacing: {
    defaultProvider: "provider-a",
    maxConcurrentSessions: 1,
    providerBudgets: { "provider-a": { usageLimit: 1 } },
    subagents: { maxDepth: 1, maxFanOut: 1 },
    usageWindowHours: 5,
  },
  products: [
    {
      epicProject: { epicId: 101, projectId: "epic-project" },
      name: "Sample product",
      repos: [
        {
          name: "sample-repository",
          repositoryRoot: "/tmp/sample-repository",
        },
      ],
    },
  ],
  pushover: {
    apiUrl: "https://notify.invalid/messages",
    applicationToken: "application-token",
    consoleBaseUrl: "https://console.invalid/",
    recipientLabel: "Primary operator",
    userKey: "operator-key",
  },
  session: {
    baseRef: "main",
    cliVersion: "1.0.0",
    driver: "provider-a",
    interactionMode: "default",
    model: "sample-model",
    runtimeMode: "sample-mode",
    skillPointer: "skill://sample",
  },
  stageThresholds: { implement: 10_000 },
  stateDirectory: "/tmp/sample-state",
  stopTimeoutMilliseconds: 1_000,
  t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
});

describe("production configuration", () => {
  it("keeps the runtime validator and JSON schema required surface aligned", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    ) as { properties: Record<string, unknown>; required: string[] };
    const configuration = fixture();
    expect(Object.keys(schema.properties).sort()).toEqual(
      [...Object.keys(configuration), "providerUsage", "server"].sort(),
    );
    expect([...schema.required].sort()).toEqual(
      Object.keys(configuration).sort(),
    );
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);
    const deploymentDocument = {
      ...configuration,
      providerUsage: {
        arguments: [],
        executable: "/tmp/sample-provider-usage",
        timeoutMilliseconds: 1_000,
      },
    };
    expect(validate(deploymentDocument), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(validateProductionConfiguration(configuration)).toBe(configuration);
  });

  it("rejects an invalid cadence through both configuration boundaries", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const invalid = { ...fixture(), cadenceMilliseconds: 0 };
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);
    expect(validate(invalid)).toBe(false);
    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "cadenceMilliseconds must be a positive safe integer",
    );
  });

  it("rejects a pacing provider that the session boundary cannot dispatch", () => {
    const invalid = {
      ...fixture(),
      pacing: { ...fixture().pacing, defaultProvider: "provider-b" },
    };

    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "pacing.defaultProvider must equal session.driver",
    );
  });

  it("rejects a recipient label that contains a Pushover credential", () => {
    const invalid = {
      ...fixture(),
      pushover: {
        ...fixture().pushover,
        recipientLabel: "Primary operator-key recipient",
      },
    };

    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "pushover.recipientLabel must not contain a Pushover credential",
    );
  });

  it("rejects a whitespace-only recipient label through both configuration boundaries", async () => {
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const invalid = {
      ...fixture(),
      providerUsage: {
        arguments: [],
        executable: "/tmp/sample-provider-usage",
        timeoutMilliseconds: 1_000,
      },
      pushover: { ...fixture().pushover, recipientLabel: "   " },
    };
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);

    expect(validate(invalid)).toBe(false);
    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "pushover.recipientLabel must not be empty",
    );
  });

  it("rejects a repository referenced by more than one product", () => {
    const invalid: ProductionConfiguration = {
      ...fixture(),
      products: [
        ...fixture().products,
        {
          name: "Second product",
          repos: [
            {
              name: "sample-repository",
              repositoryRoot: "/tmp/second-repository",
            },
          ],
        },
      ],
    };

    expect(() => validateProductionConfiguration(invalid)).toThrow(
      "must belong to exactly one product",
    );
  });

  it.each([
    {
      name: "t3.baseUrl",
      mutate: (configuration: ProductionConfiguration) => ({
        ...configuration,
        t3: { ...configuration.t3, baseUrl: "local-t3" },
      }),
    },
    {
      name: "pushover.apiUrl",
      mutate: (configuration: ProductionConfiguration) => ({
        ...configuration,
        pushover: { ...configuration.pushover, apiUrl: "local-notifier" },
      }),
    },
    {
      name: "pushover.consoleBaseUrl",
      mutate: (configuration: ProductionConfiguration) => ({
        ...configuration,
        pushover: {
          ...configuration.pushover,
          consoleBaseUrl: "local-console",
        },
      }),
    },
  ])(
    "rejects non-HTTP $name through both configuration boundaries",
    async ({ mutate, name }) => {
      const schema = JSON.parse(
        await readFile("schemas/production-configuration.json", "utf8"),
      );
      const invalid = mutate(fixture());
      const validate = new Ajv2020({
        allErrors: true,
        formats: { uri: true },
        strict: false,
      }).compile(schema);

      expect(validate(invalid)).toBe(false);
      expect(() => validateProductionConfiguration(invalid)).toThrow(
        `${name} must be an HTTP URL`,
      );
    },
  );
});
