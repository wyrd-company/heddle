// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { GitHubBindingService } from "../src/binding/service.js";
import { RunStore } from "../src/engine/store.js";
import { webhookServer } from "../src/service/webhook.js";
import { fixture } from "./binding.fixture.js";

it("applies signed HTTP delivery through the existing binding handler and contains invalid signatures", async () => {
  const wire = fixture();
  const store = new RunStore(":memory:");
  const binding = new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    wire.clients,
    () => Promise.resolve([]),
    {
      resolveBlueprint: () => Promise.reject(new Error("No blueprint needed")),
    },
  );
  const errors: string[] = [];
  const server = webhookServer(binding.events, () => "sample-secret", {
    output: () => undefined,
    error: (message) => {
      errors.push(message);
    },
  });
  try {
    await binding.start();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const issue = wire.issues.at(0);
    if (!issue) throw new Error("Missing fixture issue");
    issue.title = "Updated recipe";
    issue.updatedAt = "2026-01-02T00:00:00Z";
    const body = JSON.stringify({
      issue: { node_id: issue.id, updated_at: issue.updatedAt },
    });
    const signature = `sha256=${createHmac("sha256", "sample-secret").update(body).digest("hex")}`;
    for (const invalid of ["", "sha256=invalid", `sha256=${"0".repeat(64)}`]) {
      const response = await fetch(origin + "/webhook/github", {
        method: "POST",
        headers: { "x-github-event": "issues", "x-hub-signature-256": invalid },
        body,
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
      expect(binding.instances.get(issue.id).issue.title).toBe("Garden soup");
    }
    expect(errors).toEqual(
      Array<string>(3).fill("GitHub webhook signature is invalid"),
    );
    const accepted = await fetch(origin + "/webhook/github", {
      method: "POST",
      headers: { "x-github-event": "issues", "x-hub-signature-256": signature },
      body,
    });
    expect(accepted.status).toBe(202);
    expect(binding.instances.get(issue.id).issue.title).toBe("Updated recipe");
    issue.title = "Polled recipe";
    issue.updatedAt = "2026-01-03T00:00:00Z";
    await binding.poll();
    expect(binding.instances.get(issue.id).issue.title).toBe("Polled recipe");
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    store.close();
  }
});
