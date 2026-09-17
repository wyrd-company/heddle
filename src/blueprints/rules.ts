// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
export interface ValidationRuleDescription {
  readonly name: string;
  readonly description: string;
}

export const VALIDATION_RULES: readonly ValidationRuleDescription[] = [
  { name: "yaml.parse", description: "The source is valid YAML 1.2." },
  {
    name: "blueprint.schema",
    description: "The document satisfies the blueprint JSON Schema.",
  },
  {
    name: "blueprint.id",
    description: "The blueprint id matches the source filename.",
  },
  {
    name: "node.params",
    description: "Node params satisfy the registered node-type schema.",
  },
  {
    name: "reference.exists",
    description: "Referenced templates, schemas, and rules files exist.",
  },
  {
    name: "handoff.schema",
    description: "Handoff schemas satisfy JSON Schema and MCP constraints.",
  },
  {
    name: "expression.jsonata",
    description: "Every condition is valid JSONata syntax.",
  },
  {
    name: "heddle.no-subflow",
    description: "Blueprints do not use the Flowcraft subflow node.",
  },
  {
    name: "heddle.entry",
    description:
      "A cyclic graph declares an entry that names an authored node.",
  },
  {
    name: "heddle.no-action-edge",
    description: "Blueprint edges do not declare Flowcraft actions.",
  },
  {
    name: "heddle.unhandled-result",
    description: "Every named result of a pausing node has an outgoing edge.",
  },
  {
    name: "heddle.question-role",
    description: "Every question role has a configured channel.",
  },
  {
    name: "heddle.context-key",
    description:
      "Statically identifiable context roots have a possible provider.",
  },
  {
    name: "flowcraft.lint",
    description: "The derived Flowcraft blueprint passes its linter.",
  },
  {
    name: "roundtrip.bytes",
    description: "An unchanged loaded document saves byte-for-byte.",
  },
  {
    name: "requires.issue.live",
    description: "Live project requirements are checked when requested.",
  },
];
