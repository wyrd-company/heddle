// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { VALIDATION_RULES, validateBlueprintFile } from "../src/index.js";
import { subtractedNames } from "../src/blueprints/expression-names.js";

const RULE = "expression.hyphenated-name";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function written(files: Record<string, string>, entry: string): string {
  const directory = mkdtempSync(join(tmpdir(), "heddle-expression-"));
  temporaryDirectories.push(directory);
  for (const [name, source] of Object.entries(files)) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return join(directory, entry);
}

function findings(source: string, extra: Record<string, string> = {}) {
  return validateBlueprintFile(
    written({ "sample-a.yml": source, ...extra }, "sample-a.yml"),
  ).filter((item) => item.rule === RULE);
}

/** Every expression position, one node id the reader could only mean as a name. */
const positions: [string, string, string][] = [
  [
    "an edge condition",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  store:
    uses: terminal-result
    params: { value: stored }
edges:
  - from: weigh-parcel
    to: store
    when: weigh-parcel.payload
`,
    "edge to store when",
  ],
  [
    "a terminal-result value",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  store:
    uses: terminal-result
    params:
      value: { from: weigh-parcel.payload }
edges:
  - from: weigh-parcel
    to: store
`,
    "params.value.from",
  ],
  [
    "a reference nested under a terminal-result value",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  store:
    uses: terminal-result
    params:
      value:
        status: held
        details: [{ from: weigh-parcel.payload }]
edges:
  - from: weigh-parcel
    to: store
`,
    "params.value.details[0].from",
  ],
  [
    "a child-run input",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  reroute:
    uses: child-run
    params:
      blueprint: sample-b
      inputs:
        parcel: { from: weigh-parcel.payload }
edges:
  - from: weigh-parcel
    to: reroute
`,
    "params.inputs.parcel.from",
  ],
  [
    "a child-run output mapping",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  reroute:
    uses: child-run
    params:
      blueprint: sample-b
      outputs:
        report: weigh-parcel.payload
edges:
  - from: weigh-parcel
    to: reroute
`,
    "params.outputs.report",
  ],
  [
    "an issue-change condition",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  watch:
    uses: on-issue-change
    params:
      when: weigh-parcel.payload
edges:
  - from: weigh-parcel
    to: watch
  - from: watch
    to: weigh-parcel
    when: result.output.changed
`,
    "params.when",
  ],
  [
    "an issue-change binding",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  watch:
    uses: on-issue-change
    params:
      when: $depot = 'north'
      bindings:
        depot: weigh-parcel.payload
edges:
  - from: weigh-parcel
    to: watch
  - from: watch
    to: weigh-parcel
    when: result.output.changed
`,
    "params.bindings.depot",
  ],
  [
    "an aggregate binding path",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  total:
    uses: aggregate
    params:
      bindings:
        mass:
          node: weigh-parcel
          path: weigh-parcel.payload
edges:
  - from: weigh-parcel
    to: total
`,
    "params.bindings.mass.path",
  ],
  [
    "a lifecycle-start input",
    `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
  begin:
    uses: lifecycle-start
    params:
      blueprint: sample-b
      inputs:
        parcel: { from: weigh-parcel.payload }
edges:
  - from: weigh-parcel
    to: begin
`,
    "params.inputs.parcel.from",
  ],
];

describe("hyphenated names inside blueprint expressions", () => {
  it.each(positions)("reports %s", (_name, source, where) => {
    expect(findings(source)).toEqual([
      expect.objectContaining({
        rule: RULE,
        message: `${where} subtracts weigh-parcel instead of reading it: weigh-parcel.payload; write \`weigh-parcel\`.payload`,
      }),
    ]);
  });

  it.each(positions)("accepts the quoted form of %s", (_name, source) => {
    expect(
      findings(
        source.replaceAll("weigh-parcel.payload", '"`weigh-parcel`.payload"'),
      ),
    ).toEqual([]);
  });

  it("reports a blueprint input and a declared output", () => {
    const source = `id: sample-a
kind: helper
inputs:
  parcel-weight: { type: number }
outputs:
  routing-note: { type: string }
nodes:
  hold:
    uses: wait
  store:
    uses: terminal-result
    params:
      value:
        mass: { from: parcel-weight }
        note: { from: routing-note }
edges:
  - from: hold
    to: store
`;
    expect(findings(source).map((item) => item.message)).toEqual([
      "params.value.mass.from subtracts parcel-weight instead of reading it: parcel-weight; write `parcel-weight`",
      "params.value.note.from subtracts routing-note instead of reading it: routing-note; write `routing-note`",
    ]);
  });

  it("reports a stage visit count read through an unquoted node id", () => {
    const source = `id: sample-a
kind: helper
nodes:
  weigh-parcel:
    uses: wait
    stage: true
  store:
    uses: terminal-result
    params:
      value: { from: stages.weigh-parcel.visits }
edges:
  - from: weigh-parcel
    to: store
`;
    expect(findings(source).map((item) => item.message)).toEqual([
      "params.value.from subtracts weigh-parcel instead of reading it: stages.weigh-parcel.visits; write stages.`weigh-parcel`.visits",
    ]);
  });

  it("catches a three-part id spelled as a chain of subtractions", () => {
    const source = `id: sample-a
kind: helper
nodes:
  wait-for-match:
    uses: wait
  store:
    uses: terminal-result
    params:
      value: { from: wait-for-match.payload }
edges:
  - from: wait-for-match
    to: store
`;
    expect(findings(source).map((item) => item.message)).toEqual([
      "params.value.from subtracts wait-for-match instead of reading it: wait-for-match.payload; write `wait-for-match`.payload",
    ]);
  });

  it("leaves arithmetic alone when neither operand join names anything", () => {
    const source = `id: sample-a
kind: helper
inputs:
  total: { type: number }
  used: { type: number }
nodes:
  hold:
    uses: wait
  store:
    uses: terminal-result
    params:
      value: { from: total - used }
edges:
  - from: hold
    to: store
    when: total - used > 0
`;
    expect(findings(source)).toEqual([]);
  });

  it("reports a hyphenated name inside a policy rules artifact", () => {
    const source = `id: sample-a
kind: helper
nodes:
  classify:
    uses: policy
    params:
      rules: rules/sample.yml
      input: { from: issue }
  store:
    uses: terminal-result
    params: { value: done }
edges:
  - from: classify
    to: store
`;
    const rules = `rules:
  - id: heavy-parcel
    when: mass > 10
    blueprint: sample-b
    inputs:
      note: { from: heavy-parcel.label }
  - id: fallback
    blueprint: sample-b
`;
    const results = findings(source, { "rules/sample.yml": rules });
    expect(results.map((item) => item.message)).toEqual([
      "inputs.note.from subtracts heavy-parcel instead of reading it: heavy-parcel.label; write `heavy-parcel`.label",
    ]);
    expect(results[0]?.file).toContain("rules/sample.yml");
  });

  it("reads a subtraction only as a name the expression could mean", () => {
    const names = new Set(["weigh-parcel", "wait-for-match"]);
    expect(subtractedNames("total - used", names)).toEqual([]);
    expect(subtractedNames("weigh - parcel", names)).toEqual([
      { name: "weigh-parcel", corrected: "`weigh-parcel`" },
    ]);
    expect(subtractedNames("count-1", names)).toEqual([]);
    expect(subtractedNames("`weigh-parcel`.payload", names)).toEqual([]);
    expect(
      subtractedNames("result.output.timeout and weigh-parcel.payload", names),
    ).toEqual([{ name: "weigh-parcel", corrected: "`weigh-parcel`.payload" }]);
  });

  it("publishes the rule in the registry", () => {
    expect(VALIDATION_RULES.map((rule) => rule.name)).toContain(RULE);
  });

  it("keeps the negative corpus fixture bound to the rule", () => {
    const file = resolve(
      "test/fixtures/blueprints/negative/hyphenated-reference.yml",
    );

    expect(validateBlueprintFile(file).map((item) => item.rule)).toContain(
      RULE,
    );
  });
});
