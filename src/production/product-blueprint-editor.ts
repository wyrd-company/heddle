// ---
// relationships:
//   implements: heddle
// ---

import type { ConsoleBlueprintEditor } from "../console/index.js";
import {
  BlueprintArtifactEditor,
  type LifecycleEffect,
} from "../engine/index.js";
import type { ProductConfiguration } from "./configuration.js";

export class ProductBlueprintArtifactEditor implements ConsoleBlueprintEditor {
  private readonly editors: BlueprintArtifactEditor[];

  constructor(options: {
    effects: Record<string, LifecycleEffect>;
    products: ProductConfiguration[];
  }) {
    this.editors = options.products.flatMap((product) =>
      product.repos.map(
        (repository) =>
          new BlueprintArtifactEditor({
            effects: options.effects,
            repositoryRoot: repository.repositoryRoot,
          }),
      ),
    );
  }

  async load(artifactId: string) {
    const matches = await this.matches(artifactId);
    if (matches.length !== 1) {
      throw new Error(
        `Blueprint '${artifactId}' must exist in exactly one configured repository`,
      );
    }
    return matches[0]!.revision;
  }

  async save(input: Parameters<ConsoleBlueprintEditor["save"]>[0]) {
    const matches = (await this.matches(input.artifactId)).filter(
      ({ revision }) => revision.blobHash === input.expectedBlobHash,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Blueprint '${input.artifactId}' revision must identify one configured repository`,
      );
    }
    return matches[0]!.editor.save(input);
  }

  private async matches(artifactId: string) {
    const settled = await Promise.allSettled(
      this.editors.map(async (editor) => ({
        editor,
        revision: await editor.load(artifactId),
      })),
    );
    return settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
  }
}
