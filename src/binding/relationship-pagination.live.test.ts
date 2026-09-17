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

it.skipIf(!process.env["HEDDLE_RELATIONSHIP_LIVE"])(
  "loads a later sub-issue page through Heddle's App",
  async () => {
    const credentialsPath = process.env["HEDDLE_BINDING_CREDENTIALS"];
    const ownerName = process.env["HEDDLE_BINDING_OWNER"];
    const repoName = process.env["HEDDLE_BINDING_REPO"];
    if (!credentialsPath || !ownerName || !repoName)
      throw new Error("Set HEDDLE_BINDING_CREDENTIALS, OWNER and REPO");

    const budget = { graphql: 0, rest: 0, mutations: 0 };
    const clients = appClients(credentialsPath, budget, {
      relationshipPageSize: 1,
    });
    const repo = clients(ownerName).owner(ownerName).repo(repoName);
    const suffix = randomUUID();
    const issues: Awaited<ReturnType<typeof repo.issues.create>>[] = [];
    let qualified = false;
    let loadRequests = 0;
    try {
      const parent = await repo.issues.create({
        title: `Fixture parent ${suffix}`,
      });
      const first = await repo.issues.create({
        title: `Fixture child A ${suffix}`,
      });
      const second = await repo.issues.create({
        title: `Fixture child B ${suffix}`,
      });
      issues.push(parent, first, second);
      await parent.link({ subIssues: [first, second] });

      const before = budget.graphql;
      const loaded = await parent.load();
      loadRequests = budget.graphql - before;
      expect(loaded.subIssues).toEqual(
        expect.arrayContaining([first.ref, second.ref]),
      );
      expect(loaded.subIssues).toHaveLength(2);
      expect(loadRequests).toBe(2);
      qualified = true;
    } catch (error) {
      // Do not retain SDK causes: request metadata can include authentication material.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      const cleanup = await Promise.allSettled(
        issues.map((issue) => issue.close()),
      );
      const evidence = {
        qualified,
        relationship: "subIssues",
        relationshipPageSize: 1,
        loadedRelationships: 2,
        loadRequests,
        cleanup: cleanup.every((result) => result.status === "fulfilled"),
        budget,
      };
      const evidencePath = process.env["HEDDLE_RELATIONSHIP_EVIDENCE"];
      if (evidencePath)
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence));
      expect(evidence.cleanup).toBe(true);
    }
  },
);
