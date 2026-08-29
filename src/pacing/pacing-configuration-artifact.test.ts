// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import type { PacingConfiguration } from "./index.js";
import { PROVIDER_USAGE_WINDOW_MS } from "./index.js";

const schemaPath = "schemas/pacing-configuration.json";
const schemaId = "https://wyrd.company/heddle/pacing-configuration.schema.json";
const validConfiguration = {
  $schema: schemaId,
  relationships: { implements: "heddle" },
  defaultProvider: "provider-a",
  maxConcurrentSessions: 3,
  providerBudgets: {
    "provider-a": { usageLimit: 80 },
  },
  subagents: { maxDepth: 2, maxFanOut: 2 },
  usageWindowHours: 5,
} as const;

const readSchema = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;

describe("pacing configuration artifact", () => {
  it("validates the runtime configuration shape", async () => {
    const runtimeConfiguration: PacingConfiguration = validConfiguration;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      await readSchema(),
    );

    expect(
      validate(runtimeConfiguration),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(PROVIDER_USAGE_WINDOW_MS).toBe(
      runtimeConfiguration.usageWindowHours * 60 * 60 * 1_000,
    );
  });

  it("binds the schema identity, relationship, and filename-derived ID", async () => {
    const schema = await readSchema();

    expect(schema["$id"]).toBe(schemaId);
    expect(schema["relationships"]).toEqual({ implements: "heddle" });
    expect(basename(schemaPath, extname(schemaPath))).toMatch(
      /^[a-z]+(?:-[a-z]+)*$/,
    );
  });

  it("rejects a different window and negative capacity", async () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      await readSchema(),
    );

    expect(validate({ ...validConfiguration, usageWindowHours: 4 })).toBe(
      false,
    );
    expect(validate({ ...validConfiguration, maxConcurrentSessions: -1 })).toBe(
      false,
    );
  });
});
