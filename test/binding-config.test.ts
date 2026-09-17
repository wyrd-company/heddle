// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { appClients, bindingConfigSchema } from "../src/binding/config.js";
import { ScriptedTransport } from "../src/github/testing.js";

it("consumes App credentials only, routes installations, and counts requests without exposing credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "binding-auth-"));
  const path = join(directory, "auth.yml");
  try {
    const budget = { graphql: 0, rest: 0, mutations: 0 };
    writeFileSync(path, "token: example-test-value\n");
    expect(() => appClients(path, budget)).toThrow(
      "Invalid Heddle GitHub App credential file",
    );
    writeFileSync(path, "private-key: [example-test-value\n");
    expect(() => appClients(path, budget)).toThrow(
      "Cannot parse Heddle GitHub App credential file",
    );
    writeFileSync(
      path,
      "app-id: 123\ninstallations:\n  sample-owner: 456\nprivate-key: example-test-value\n",
    );
    const wire = new ScriptedTransport({
      graphql: { raw: () => ({}) },
      rest: { "GET /example": () => ({}), "POST /example": () => ({}) },
    });
    const clients = appClients(path, budget, () => wire);
    expect(() => clients("another-owner")).toThrow(
      "no configured installation",
    );
    const client = clients("sample-owner");
    await client.raw.graphql("query { example }");
    await client.raw.graphql("mutation { example }");
    await client.raw.rest("GET /example");
    await client.raw.rest("POST /example");
    expect(budget).toEqual({ graphql: 2, rest: 2, mutations: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("accepts the documented service configuration", () => {
  expect(
    bindingConfigSchema.parse({
      projects: [{ owner: "sample-owner", number: 1 }],
      github: { credentialFile: "/secrets/app.yml" },
      blueprints: { repository: "/workspace/recipes" },
      t3Code: {
        endpoint: "http://127.0.0.1:3000",
        tokenFile: "/secrets/session",
      },
      webhook: { secretFile: "/secrets/webhook" },
    }).github.credentialFile,
  ).toBe("/secrets/app.yml");
});
