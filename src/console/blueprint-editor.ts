// ---
// relationships:
//   implements: heddle
// ---

import type {
  BlueprintArtifactRevision,
  SaveBlueprintArtifactInput,
} from "../engine/index.js";

export interface ConsoleBlueprintEditor {
  load(artifactId: string): Promise<BlueprintArtifactRevision>;
  save(input: SaveBlueprintArtifactInput): Promise<BlueprintArtifactRevision>;
}
