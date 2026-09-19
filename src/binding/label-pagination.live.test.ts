// ---
// relationships:
//   verifies:
//     - github-client
//     - github-binding-and-intake
// ---
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { appClients } from "./config.js";

it.skipIf(!process.env["HEDDLE_LABEL_LIVE"])(
  "loads a later attached-label page through Heddle's App",
  async () => {
    const credentialsPath = process.env["HEDDLE_BINDING_CREDENTIALS"];
    const ownerName = process.env["HEDDLE_BINDING_OWNER"];
    const repoName = process.env["HEDDLE_BINDING_REPO"];
    if (!credentialsPath || !ownerName || !repoName)
      throw new Error("Set HEDDLE_BINDING_CREDENTIALS, OWNER and REPO");

    const budget = { graphql: 0, rest: 0, mutations: 0 };
    const clients = appClients(credentialsPath, budget, { labelPageSize: 1 });
    const repo = clients(ownerName).owner(ownerName).repo(repoName);
    const suffix = randomUUID();
    const labelNames = [`fixture-${suffix}-a`, `fixture-${suffix}-b`];
    const labelsCreated: string[] = [];
    let issue: Awaited<ReturnType<typeof repo.issues.create>> | undefined;
    let qualified = false;
    let loadRequests = 0;
    let loadedLabels = 0;
    try {
      for (const name of labelNames) {
        await repo.labels.create({ name, color: "BBBBBB" });
        labelsCreated.push(name);
      }
      issue = await repo.issues.create({
        title: `Fixture record ${suffix}`,
        labels: labelNames,
      });

      const before = budget.graphql;
      const loaded = await issue.load();
      loadRequests = budget.graphql - before;
      loadedLabels = loaded.labels.length;
      expect(loaded.labels.map((label) => label.name)).toEqual(
        expect.arrayContaining(labelNames),
      );
      expect(loaded.labels).toHaveLength(2);
      expect(loadRequests).toBe(2);
      qualified = true;
    } catch (error) {
      // Do not retain SDK causes: request metadata can include authentication material.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      const cleanup = await Promise.allSettled([
        ...(issue ? [issue.close()] : []),
        ...labelsCreated.map((name) => repo.labels.delete(name)),
      ]);
      const evidence = {
        qualified,
        labelPageSize: 1,
        loadedLabels,
        loadRequests,
        cleanup: cleanup.every((result) => result.status === "fulfilled"),
        budget,
      };
      const evidencePath = process.env["HEDDLE_LABEL_EVIDENCE"];
      if (evidencePath)
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence));
      expect(evidence.cleanup).toBe(true);
    }
  },
);
