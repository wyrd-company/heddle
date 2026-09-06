// ---
// relationships:
//   verifies: heddle
// ---

import type {
  HandoffTemplateResolver,
  SessionTemplateAuthority,
} from "./session-bootstrap.js";

export const sampleHandoffTemplate = {
  commitSha: "b".repeat(40),
  path: "handoff-templates/sample.md",
};

export const readSampleHandoffTemplate: HandoffTemplateResolver = async (
  reference,
  input,
) => ({
  ...reference,
  body: "# {{ task.title }}\n\nStage: {{ handoff.stage.name }}\n",
  includes: {},
  kind: input.handoff.stage.kind,
});

export const sampleTemplateAuthority: SessionTemplateAuthority = {
  readHandoffTemplate: readSampleHandoffTemplate,
  repositoryRoot: "/workspaces/sample-blueprints",
};
