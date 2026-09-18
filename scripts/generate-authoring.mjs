// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { format } from "prettier";

const contracts = JSON.parse(
  await readFile("src/blueprints/node-types.json", "utf8"),
);
const outputRoot = process.argv[2] ?? ".";
const hookFiles = JSON.parse(
  await readFile("src/agent-tools/plugin-contracts.json", "utf8"),
);
const schema = parse(
  await readFile("docs/specifications/blueprint.schema.yml", "utf8"),
);
const rulesSource = await readFile("src/blueprints/rules.ts", "utf8");
const rules = [
  ...rulesSource.matchAll(
    /name: "([^"]+)"[\s\S]*?description:\s*(?:"([^"]+)"|\n\s*"([^"]+)")/g,
  ),
].map((match) => ({ name: match[1], description: match[2] ?? match[3] }));

const shipped = (await readdir("blueprints", { recursive: true }))
  .filter((path) => path.endsWith(".yml") && !path.startsWith("rules/"))
  .sort();

const definitionName = (contract) =>
  contract.paramsSchema.$ref.split("/").at(-1);
const fenced = (value) =>
  `\n\`\`\`yaml\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const documentSchema = Object.fromEntries(
  Object.entries(schema).filter(([key]) => key !== "$defs"),
);
const sharedDefinitions = Object.fromEntries(
  Object.entries(schema.$defs).filter(([key]) => !key.endsWith("Params")),
);
let reference = `---\nrelationships:\n  implements:\n    - blueprint-authoring\n    - node-types\n---\n\n# Blueprint author reference\n\nThis file is generated from the node-type registry, blueprint schema, validation-rule registry, shipped blueprints, and hook-plugin file registry. Run \`task build\` to regenerate it.\n\n## Engine agreement\n\nHeddle dispatches Flowcraft nodes sequentially with engine concurrency 1. Durable snapshot checkpointing and the one-terminal-result guard depend on that order. A concurrency change must replace those agreements before it changes dispatch.\n\nEvery completed node writes its output below its authored node id. A pausing result is also exposed during edge routing as \`result.output.<result>\`; its wake payload is \`result.output.payload\`. Every node marked \`stage: true\` writes its visit count to \`stages.<node-id>.visits\`, whatever its node type, before the edges leaving it are evaluated.\n\nThe running blueprint is a reserved context root. Edge conditions, \`{ from: <expression> }\` references, and templates read \`blueprint.id\` and \`blueprint.metadata\`, the blueprint\'s own top-level metadata bag, which is \`{}\` when none is authored. A child run reads its own blueprint, never its parent\'s.\n\n## Templates\n\nOne renderer serves every \`templateRef\`. A string is a path from the blueprint root, \`{ inline }\` is template text, and both render as Nunjucks with autoescaping off and undefined values fatal. Each template reads the run context, the running blueprint as \`blueprint\`, and the node\'s own \`metadata\`, \`node\`, and \`input\`.\n\nA \`templateRef\` path is read from the run\'s pinned commit and resolves from the blueprint root, the directory Heddle is pointed at, whatever subdirectory holds the blueprint file. A template may load another with \`include\`, \`import\`, or \`extends\`; those targets resolve from that same blueprint root at the same pinned commit. A target that leaves the blueprint root is refused.\n\n## Minimal blueprint\n\n\`\`\`yaml\nid: sample-process\nkind: helper\nnodes:\n  hold:\n    uses: wait\n  finish:\n    uses: terminal-result\n    params:\n      value: done\nedges:\n  - from: hold\n    to: finish\n\`\`\`\n\n## Blueprint document\n\nThe complete authored document shape is below. Node-type inputs follow in the catalog.\n${fenced(documentSchema)}\n### Shared schema definitions\n${fenced(sharedDefinitions)}\n## Node types\n\nThe catalog below publishes every designed node type and, for a node type that takes an operation, every designed operation, each marked available or not. \`heddle validate\` rejects a blueprint that uses a node type or an operation that is not available yet.\n`;
for (const [name, contract] of Object.entries(contracts)) {
  const params = schema.$defs[definitionName(contract)];
  const operations = contract.operations
    ? `\n- Operations: ${Object.entries(contract.operations)
        .map(
          ([operation, available]) =>
            `\`${operation}\`${available ? "" : " (not available yet)"}`,
        )
        .join(", ")}`
    : "";
  reference += `\n### \`${name}\`\n\n${contract.description}\n\n- Available: ${contract.available ? "yes" : "no, Heddle has no run-time implementation for it yet"}${operations}\n- Pausing: ${contract.pausing ? "yes" : "no"}\n- Results: ${contract.results.length ? contract.results.map((x) => `\`${x}\``).join(", ") : "none"}\n- Context keys written: ${contract.contextWrites.map((x) => `\`${x}\``).join(", ")}\n- Inputs and defaults:${fenced(params)}- Output:${fenced(contract.outputSchema)}`;
}
reference += `\n## Validation rules\n\n${rules.map((rule) => `- \`${rule.name}\`: ${rule.description}`).join("\n")}\n\n## Shipped blueprints\n\n${shipped.map((path) => `- \`blueprints/${path}\``).join("\n")}\n\n## Harness hook files\n\n${Object.entries(
  hookFiles,
)
  .map(
    ([harness, files]) =>
      `### ${harness}\n\n${files.map((path) => `- \`${path}\``).join("\n")}`,
  )
  .join("\n\n")}\n`;

const skill = `---\nname: blueprint-authoring\ndescription: Author and repair Heddle blueprint repositories from the embedded node contracts. Use when creating or editing Heddle blueprint YAML, referenced templates, handoff schemas, policy rules, or child-run compositions.\nmetadata:\n  relationships:\n    implements: blueprint-authoring\n---\n\n# Author Heddle blueprints\n\nRead \`references/blueprint-author-reference.md\` before editing. It is generated from the same contracts that Heddle validates.\n\nNode ids are hyphenated slugs and JSONata reads a bare hyphen as subtraction, so inside any expression a node, input, or output id is written in backticks - \`start-hold\`.payload, never start-hold.payload - and the whole expression is then quoted in YAML.\n\nUse generic names and scenarios. Write every path - template, handoff schema, policy rules, and every \`include\`, \`import\`, and \`extends\` target - relative to the blueprint root, the directory Heddle is pointed at, and never above it; a blueprint in a subdirectory of the root prefixes its paths with that subdirectory. Use condition edges for routing and route every named result of each pausing node. Do not use action edges or Flowcraft subflows. The catalog publishes every designed node type and operation and marks each one available or not; \`heddle validate\` rejects a blueprint that uses one Heddle cannot run yet.\n\nAfter every blueprint or referenced-file edit, run:\n\n\`\`\`sh\nheddle validate --json <file-or-blueprint-root>\n\`\`\`\n\nRead every finding, fix it, and rerun the same command. Continue until the JSON output is \`[]\`. Do not treat readable YAML, schema validation alone, or an earlier clean run as validation of the latest edit.\n\nHeddle dispatches nodes sequentially. Do not author or document a workflow that depends on concurrent node execution.\n`;

const generatedModule = `// Generated by scripts/generate-authoring.mjs.\nexport const BLUEPRINT_AUTHORING_SKILL = ${JSON.stringify(skill)};\nexport const BLUEPRINT_AUTHOR_REFERENCE = ${JSON.stringify(reference)};\n`;
for (const [path, content] of [
  ["docs/reference/blueprint-author-reference.md", reference],
  ["skills/blueprint-authoring/SKILL.md", skill],
  [
    "skills/blueprint-authoring/references/blueprint-author-reference.md",
    reference,
  ],
  ["src/generated/blueprint-authoring.ts", generatedModule],
]) {
  const output = join(outputRoot, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    await format(content, {
      filepath: path,
      proseWrap: "preserve",
    }),
  );
}
