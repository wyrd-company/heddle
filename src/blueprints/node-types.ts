// ---
// relationships:
//   implements: node-types
// ---
import type { JsonObject } from "./types.js";

export interface NodeTypeContract {
  readonly paramsSchema: JsonObject;
  readonly pausing: boolean;
  readonly results: readonly string[];
}

const schemaReference = (definition: string): JsonObject => ({
  $ref: `https://heddle.wyrd.company/schemas/blueprint#/$defs/${definition}`,
});

export const NODE_TYPE_REGISTRY = {
  "child-run": {
    paramsSchema: schemaReference("childRunParams"),
    pausing: true,
    results: ["completed", "failed"],
  },
  "lifecycle-start": {
    paramsSchema: schemaReference("lifecycleStartParams"),
    pausing: false,
    results: ["started"],
  },
  pass: {
    paramsSchema: schemaReference("passParams"),
    pausing: true,
    results: [
      "handoff",
      "escalate",
      "timeout",
      "idle",
      "turnEnded",
      "overridden",
    ],
  },
  question: {
    paramsSchema: schemaReference("questionParams"),
    pausing: true,
    results: ["answered", "timeout"],
  },
  "on-issue-change": {
    paramsSchema: schemaReference("onIssueChangeParams"),
    pausing: true,
    results: ["changed", "timeout"],
  },
  github: {
    paramsSchema: schemaReference("githubParams"),
    pausing: false,
    results: [],
  },
  git: {
    paramsSchema: schemaReference("gitParams"),
    pausing: false,
    results: [],
  },
  "terminal-result": {
    paramsSchema: schemaReference("terminalResultParams"),
    pausing: false,
    results: [],
  },
  aggregate: {
    paramsSchema: schemaReference("aggregateParams"),
    pausing: false,
    results: [],
  },
  notify: {
    paramsSchema: schemaReference("notifyParams"),
    pausing: false,
    results: [],
  },
  policy: {
    paramsSchema: schemaReference("policyParams"),
    pausing: false,
    results: [],
  },
  sleep: {
    paramsSchema: schemaReference("sleepParams"),
    pausing: true,
    results: [],
  },
  wait: {
    paramsSchema: schemaReference("waitParams"),
    pausing: true,
    results: [],
  },
} as const satisfies Record<string, NodeTypeContract>;

export type NodeTypeName = keyof typeof NODE_TYPE_REGISTRY;

export const isNodeTypeName = (value: string): value is NodeTypeName =>
  Object.hasOwn(NODE_TYPE_REGISTRY, value);
