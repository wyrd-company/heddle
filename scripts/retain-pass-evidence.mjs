// ---
// relationships:
//   verifies: agent-tools
// ---
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [manifestPath, outputPath] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const result = {
  relationships: { verifies: ["node-types", "agent-tools"] },
  redaction:
    "Native session, thread, and request identities are exact and unchanged. Endpoint paths, authorization values, and approval command text are omitted. Each scenario owns a fresh server, profile, socket, and state directory; foreign or cross-scenario session identities reject retention.",
  sourceHead: manifest.sourceHead,
  t3ProductionHead: manifest.t3Head,
  harnesses: manifest.harnesses,
  scenarios: {},
};
const owners = new Map();
for (const entry of manifest.cases) {
  assert.equal(entry.exit, 0, "scenario completed successfully");
  const provenance = JSON.parse(
    await readFile(join(entry.state, "provenance.json"), "utf8"),
  );
  assert.equal(provenance.sourceHead, manifest.sourceHead);
  assert.equal(provenance.t3Head, manifest.t3Head);
  assert.equal(provenance.provider, entry.provider);
  assert.equal(provenance.scenario, entry.scenario);
  const name = `${entry.provider}-${entry.scenario}`;
  const ids = new Set(
    provenance.participants.map((participant) => participant.nativeSessionId),
  );
  for (const id of ids) {
    assert.equal(typeof id, "string", "public native identity is present");
    assert.ok(!owners.has(id), "native identity belongs to only one scenario");
    owners.set(id, name);
  }
  const raw = await readFile(join(entry.state, "ordering.jsonl"), "utf8");
  const events = raw.trim().split("\n").map(JSON.parse);
  for (const event of events.filter((event) =>
    ["native-stop", "hook-decision"].includes(event.kind),
  ))
    assert.ok(
      ids.has(event.data.session_id),
      "callback identity belongs to the scenario public sessions",
    );
  if (entry.scenario === "observe") {
    assert.equal(provenance.hookMode, "untrusted");
    assert.equal(
      events.filter((event) => event.kind === "native-stop").length,
      0,
      "untrusted observation has no native hook callback",
    );
  }
  const state = JSON.parse(
    await readFile(join(entry.state, "result.json"), "utf8"),
  );
  const ordering = [];
  for (const event of events) {
    let data = event.data;
    if (event.kind === "approval-before-response")
      data = {
        requestId: data.request.requestId,
        requestType: data.request.requestType,
        observedRequestIds: data.view.openRequests.map(
          (request) => request.requestId,
        ),
      };
    else if (
      ![
        "boundary",
        "reconciled",
        "terminal-token-rejection",
        "native-stop",
        "hook-decision",
        "hook-response",
        "policy-request",
        "tool-response",
        "public-turn-settled",
      ].includes(event.kind) &&
      !(event.kind === "public-activity" && data.kind.startsWith("approval."))
    )
      continue;
    ordering.push({
      elapsedMs: event.at - events[0].at,
      kind: event.kind,
      data,
    });
  }
  result.scenarios[name] = {
    provenance: {
      ...provenance,
      rawOrderingSha256: createHash("sha256").update(raw).digest("hex"),
    },
    runs: state.runs.map(({ id, status }) => ({ id, status })),
    results: state.events
      .filter((event) => event.type === "resume")
      .map((event) => event.payload.result),
    ordering,
  };
}
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
