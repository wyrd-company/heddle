// ---
// relationships:
//   verifies: heddle
// ---

import type { HandoffTemplateResolver } from "./session-bootstrap.js";

export const sampleHandoffTemplate = {
  blobHash: "b".repeat(40),
  path: "handoff-templates/sample.md",
};

export const readSampleHandoffTemplate: HandoffTemplateResolver = async (
  reference,
  input,
) => ({
  ...reference,
  body: "# {{ task.title }}\n\nStage: {{ handoff.stage.name }}\n",
  kind: input.handoff.stage.kind,
});
