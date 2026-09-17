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
    name: "repository.child-missing",
    description: "Every child-run target exists in the complete repository.",
  },
  {
    name: "repository.child-duplicate",
    description: "A child-run target resolves to exactly one blueprint file.",
  },
  {
    name: "repository.child-kind",
    description: "A stage-marked child-run targets a stage blueprint.",
  },
  {
    name: "repository.child-output-path",
    description: "Direct child output mapping paths are declared by the child.",
  },
  {
    name: "repository.output-schema",
    description: "Blueprint output declarations are valid JSON Schemas.",
  },
  {
    name: "repository.output-shape",
    description:
      "Known terminal shapes do not contradict declared outputs.result.",
  },
  {
    name: "repository.child-output-shape",
    description:
      "A mapped child result has no statically proven terminal shape contradiction.",
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
    name: "policy.schema",
    description: "Policy rule artifacts satisfy the policy rule JSON Schema.",
  },
  {
    name: "policy.rule-id",
    description: "Policy rule ids are unique within one artifact.",
  },
  {
    name: "policy.fallback-order",
    description: "No policy rule follows a condition-less fallback.",
  },
  {
    name: "expression.jsonata",
    description: "Every condition is valid JSONata syntax.",
  },
  {
    name: "heddle.owned-field",
    description:
      "GitHub nodes do not write service-owned Status or Paused fields.",
  },
  {
    name: "heddle.no-subflow",
    description: "Blueprints do not use the Flowcraft subflow node.",
  },
  {
    name: "heddle.entry",
    description:
      "Entry is declared only when every node has an incoming edge, and names an authored node.",
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
  {
    name: "requires.issue.stage-name",
    description:
      "Stage node names are live project single-select options when requested.",
  },
];
