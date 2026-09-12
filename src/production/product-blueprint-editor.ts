// ---
// relationships:
//   implements: heddle
// ---

import type { ConsoleBlueprintEditor } from "../console/index.js";
import {
  BlueprintArtifactEditor,
  type LifecycleEffect,
} from "../engine/index.js";
import type { OrganizationBlueprintRepository } from "./blueprint-repository.js";

export class OrganizationBlueprintArtifactEditor implements ConsoleBlueprintEditor {
  private readonly editor: BlueprintArtifactEditor;

  public constructor(options: {
    effects: Record<string, LifecycleEffect>;
    repository: OrganizationBlueprintRepository;
  }) {
    this.editor = new BlueprintArtifactEditor({
      effects: options.effects,
      repositoryRoot: options.repository.repositoryRoot,
      transaction: options.repository.transaction(),
    });
  }

  load(artifactId: string) {
    return this.editor.load(artifactId);
  }

  save(input: Parameters<ConsoleBlueprintEditor["save"]>[0]) {
    return this.editor.save(input);
  }
}
