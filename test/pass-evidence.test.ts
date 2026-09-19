// ---
// relationships:
//   verifies: agent-tools
// ---
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
interface Evidence {
  scenarios: Record<
    string,
    {
      ordering: { data: { session_id: string } }[];
      provenance: {
        participants: { nativeSessionId: string }[];
        rawOrderingSha256: string;
      };
    }
  >;
}
function fixture(scenario = "block", callback = "native-first") {
  const root = mkdtempSync(join(tmpdir(), "pass-evidence-"));
  roots.push(root);
  writeFileSync(
    join(root, "provenance.json"),
    JSON.stringify({
      sourceHead: "source",
      t3Head: "provider",
      provider: "codex",
      scenario,
      hookMode: scenario === "observe" ? "untrusted" : "trusted",
      participants: [
        {
          role: "pass",
          threadId: "thread-first",
          nativeSessionId: "native-first",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "ordering.jsonl"),
    JSON.stringify({
      at: 1,
      kind: "native-stop",
      data: { session_id: callback },
    }) + "\n",
  );
  writeFileSync(
    join(root, "result.json"),
    JSON.stringify({ runs: [], events: [] }),
  );
  const entry = { exit: 0, state: root, provider: "codex", scenario };
  const retain = (cases = [entry]) => {
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        sourceHead: "source",
        t3Head: "provider",
        harnesses: {},
        cases,
      }),
    );
    execFileSync(
      process.execPath,
      [
        resolve("scripts/retain-pass-evidence.mjs"),
        join(root, "manifest.json"),
        join(root, "retained.json"),
      ],
      { stdio: "pipe" },
    );
    return JSON.parse(
      readFileSync(join(root, "retained.json"), "utf8"),
    ) as Evidence;
  };
  return { entry, retain };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("retains exact native identity with public provenance and a raw ordering digest", () => {
  const result = fixture().retain().scenarios["codex-block"];
  expect(result?.ordering[0]?.data.session_id).toBe("native-first");
  expect(result?.provenance.participants[0]?.nativeSessionId).toBe(
    "native-first",
  );
  expect(result?.provenance.rawOrderingSha256).toMatch(/^[a-f0-9]{64}$/);
});
it("rejects a delayed callback belonging to a different scenario", () => {
  expect(() => fixture("block", "native-prior").retain()).toThrow(
    "callback identity belongs",
  );
});
it("rejects reusing a native identity in two independently qualified scenarios", () => {
  const first = fixture();
  const second = fixture("reuse");
  expect(() => first.retain([first.entry, second.entry])).toThrow(
    "native identity belongs to only one scenario",
  );
});
it("rejects claiming no untrusted callback when the scenario records one", () => {
  expect(() => fixture("observe").retain()).toThrow(
    "untrusted observation has no native hook callback",
  );
});
it("rejects running a second native scenario in a shared fixture root", () => {
  const root = mkdtempSync(join(tmpdir(), "pass-scenario-owner-"));
  roots.push(root);
  writeFileSync(join(root, "connection.json"), "{}");
  writeFileSync(join(root, "scenario.json"), "{}");
  expect(() =>
    execFileSync(
      process.execPath,
      [resolve("scripts/qualify-pass-live.mjs"), root],
      { stdio: "pipe" },
    ),
  ).toThrow("EEXIST");
});
