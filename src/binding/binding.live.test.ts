// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createAppAuth } from "@octokit/auth-app";
import { RunStore } from "../engine/store.js";
import { deriveFlowcraftBlueprint } from "../blueprints/flowcraft.js";
import type { Blueprint } from "../blueprints/types.js";
import { appClients } from "./config.js";
import { GitHubBindingService } from "./service.js";
import { githubEffect } from "./effects.js";
import { liveRequirementFacts, requirementFindings } from "./validate.js";
import { github } from "../github/src/github.js";
import { OctokitTransport } from "../github/src/transport/octokit-transport.js";

it.skipIf(!process.env["HEDDLE_BINDING_LIVE"])(
  "qualifies binding, replay and App permission attention on a disposable project",
  async () => {
    const credentialsPath = process.env["HEDDLE_BINDING_CREDENTIALS"];
    const ownerName = process.env["HEDDLE_BINDING_OWNER"];
    const repoName = process.env["HEDDLE_BINDING_REPO"];
    if (!credentialsPath || !ownerName || !repoName)
      throw new Error("Set HEDDLE_BINDING_CREDENTIALS, OWNER and REPO");
    const budget = { graphql: 0, rest: 0, mutations: 0 };
    const clients = appClients(credentialsPath, budget);
    const client = clients(ownerName);
    const owner = client.owner(ownerName);
    const repo = owner.repo(repoName);
    const suffix = randomUUID();
    const label = `fixture-${suffix}`;
    const field = `Fixture ${suffix.slice(0, 12)}`;
    const project = await owner
      .project({
        title: `Recipe qualification ${suffix}`,
        fields: { Notes: { type: "text" } },
      })
      .ensure();
    const issues: ReturnType<typeof repo.issue>[] = [];
    const directory = mkdtempSync(join(tmpdir(), "binding-live-"));
    const store = new RunStore(join(directory, "state.db"));
    let qualified = false;
    let refusalEvidence: unknown;
    let labelCreated = false;
    let fieldCreated = false;
    try {
      await repo.labels.create({ name: label, color: "BBBBBB" });
      labelCreated = true;
      await owner.issueFields.create({ name: field, type: "text" });
      fieldCreated = true;
      const first = await repo.issues.create({
        title: "Garden soup",
        body: "<!--\n---\nservings: 4\n---\n-->\nRecipe",
      });
      issues.push(first);
      await project.add(first);
      const blueprints: Blueprint[] = [
        {
          id: "cook",
          kind: "process",
          nodes: { prepare: { stage: true, uses: "wait" } },
        },
        {
          id: "bake",
          kind: "process",
          nodes: { bake: { stage: true, uses: "wait" } },
        },
      ];
      const service = new GitHubBindingService(
        store,
        [{ owner: ownerName, number: project.number }],
        clients,
        () => Promise.resolve(blueprints),
        {
          resolveBlueprint: (_commit, id) => {
            const blueprint = blueprints.find((b) => b.id === id);
            if (!blueprint) throw new Error("Missing fixture blueprint");
            return Promise.resolve(deriveFlowcraftBlueprint(blueprint));
          },
        },
      );
      await service.start();
      let fields = [];
      for await (const f of (
        await clients(ownerName).owner(ownerName).project(project.number).open()
      ).fields.list())
        fields.push(f);
      expect(
        fields.find((f) => f.name === "Status")?.options.map((o) => o.name),
      ).toEqual(expect.arrayContaining(["prepare", "bake"]));
      expect(
        fields.find((f) => f.name === "Paused")?.options.map((o) => o.name),
      ).toEqual(["Yes", "No"]);
      const mutations = budget.mutations;
      await service.start();
      expect(budget.mutations).toBe(mutations);
      blueprints.pop();
      await service.reconcile();
      fields = [];
      for await (const f of (
        await clients(ownerName).owner(ownerName).project(project.number).open()
      ).fields.list())
        fields.push(f);
      expect(
        fields
          .find((f) => f.name === "Status")
          ?.options.some((o) => o.name === "bake"),
      ).toBe(true);
      const issueId = await first.id();
      expect(service.instances.get(issueId).issue.frontMatter).toEqual({
        servings: 4,
      });
      const second = await repo.issues.create({ title: "Roasted vegetables" });
      issues.push(second);
      await project.add(second);
      for (
        let pass = 0;
        pass < 10 && service.instances.list().length < 2;
        pass++
      )
        await service.discover();
      expect(service.instances.list()).toHaveLength(2);
      const run = await service.startInstance(
        issueId,
        "cook",
        "fixture-revision",
      );
      expect(run.status).toBe("awaiting");
      expect(
        (
          await (
            await (
              await clients(ownerName)
                .owner(ownerName)
                .project(project.number)
                .open()
            ).itemFor(first)
          )?.get()
        )?.["Status"],
      ).toBe("prepare");
      const bound = await clients(ownerName)
        .owner(ownerName)
        .project(project.number)
        .open();
      for (const params of [
        { operation: "set-field", field: "Notes", value: "Chopped" },
        { operation: "comment", body: "Ready" },
        { operation: "add-labels", labels: [label] },
      ]) {
        const context = {
          run,
          nodeId: "effect",
          visit: 1,
          effectKey: `${run.id}:${params.operation}`,
          params,
          input: null,
          context: { issue: service.instances.get(issueId).issue },
          await: () => Promise.resolve(),
        };
        await githubEffect(context, bound, client, service.instances);
        const writes = budget.mutations;
        await githubEffect(context, bound, client, service.instances);
        expect(budget.mutations).toBe(writes);
      }
      const facts = await liveRequirementFacts(clients, [
        { owner: ownerName, number: project.number },
      ]);
      expect(
        requirementFindings(
          "cook.yml",
          {
            id: "cook",
            kind: "process",
            requires: { issue: { fields: ["Notes"] } },
            nodes: { prepare: { uses: "wait", stage: true } },
          },
          facts,
        ),
      ).toEqual([]);
      // Reads use the normal App; the field mutation uses its metadata-only token.
      const secret = parse(readFileSync(credentialsPath, "utf8")) as {
        "app-id": number;
        installations: Record<string, number>;
        "private-key": string;
      };
      const installationId = secret.installations[ownerName];
      if (!installationId) throw new Error("Missing fixture installation");
      const auth = createAppAuth({
        appId: secret["app-id"],
        privateKey: secret["private-key"],
        installationId,
      });
      const installation = await auth({
        type: "installation",
        permissions: { metadata: "read" },
      });
      expect(installation.permissions).toEqual({ metadata: "read" });
      const wire = new OctokitTransport({ token: installation.token });
      const reader = new OctokitTransport({
        appId: secret["app-id"],
        privateKey: secret["private-key"],
        installationId,
      });
      const narrow = () =>
        github({
          auth: { token: installation.token },
          transport: {
            async graphql(op) {
              budget.graphql++;
              if (/\bmutation\b/u.test(op.document)) budget.mutations++;
              return (op.name === "SetIssueFieldValue" ? wire : reader).graphql(
                op,
              );
            },
            async rest(route, params) {
              budget.rest++;
              if (!route.startsWith("GET ")) budget.mutations++;
              return reader.rest(route, params);
            },
          },
        });
      const refusal: Blueprint = {
        id: "refusal",
        kind: "process",
        nodes: {
          change: {
            uses: "github",
            params: {
              operation: "set-field",
              scope: "organization",
              field,
              value: "Garden",
            },
          },
        },
      };
      const restricted = new GitHubBindingService(
        store,
        [{ owner: ownerName, number: project.number }],
        narrow,
        () => Promise.resolve([refusal]),
        {
          resolveBlueprint: () =>
            Promise.resolve(deriveFlowcraftBlueprint(refusal)),
        },
      );
      await restricted.start();
      const refused = await restricted.startInstance(
        await second.id(),
        "refusal",
        "fixture-revision",
      );
      expect(refused.status).toBe("awaiting");
      expect(store.awaiting(refused.id)[0]?.details.kind).toBe(
        "github-attention",
      );
      expect(store.events(refused.id).some((e) => e.type === "failure")).toBe(
        false,
      );
      qualified = true;
      refusalEvidence = store
        .events(refused.id)
        .find((e) => e.type === "attention")?.payload;
    } catch (error) {
      // Do not retain SDK causes: request metadata can include authentication material.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      const cleanup = await Promise.allSettled([
        ...issues.map((issue) => issue.close()),
        project.delete(),
        ...(labelCreated ? [repo.labels.delete(label)] : []),
        ...(fieldCreated ? [owner.issueFields.delete(field)] : []),
      ]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
      const evidence = {
        qualified,
        project: project.number,
        refusal: refusalEvidence,
        cleanup: cleanup.every((result) => result.status === "fulfilled"),
        budget,
      };
      const evidencePath = process.env["HEDDLE_BINDING_EVIDENCE"];
      if (evidencePath)
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence));
      expect(evidence.cleanup).toBe(true);
    }
  },
);
