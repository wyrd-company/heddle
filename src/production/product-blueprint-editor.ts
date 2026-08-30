// ---
// relationships:
//   implements: heddle
// ---

import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { ConsoleBlueprintEditor } from "../console/index.js";
import {
  BlueprintArtifactEditor,
  BlueprintValidationError,
  isBlueprintArtifactId,
  type LifecycleEffect,
} from "../engine/index.js";
import type { ProductConfiguration } from "./configuration.js";

export class ProductBlueprintArtifactEditor implements ConsoleBlueprintEditor {
  private readonly editors: Array<{
    editor: BlueprintArtifactEditor;
    repositoryRoot: string;
  }>;

  constructor(options: {
    effects: Record<string, LifecycleEffect>;
    products: ProductConfiguration[];
  }) {
    this.editors = options.products.flatMap((product) =>
      product.repos.map((repository) => ({
        editor: new BlueprintArtifactEditor({
          effects: options.effects,
          repositoryRoot: repository.repositoryRoot,
        }),
        repositoryRoot: repository.repositoryRoot,
      })),
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
    if (!isBlueprintArtifactId(artifactId)) {
      throw new BlueprintValidationError(
        "Blueprint artifact ID must be a kebab ID",
      );
    }
    const matches = [];
    for (const entry of this.editors) {
      try {
        await lstat(
          join(entry.repositoryRoot, "blueprints", `${artifactId}.json`),
        );
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw error;
      }
      matches.push({
        editor: entry.editor,
        revision: await entry.editor.load(artifactId),
      });
    }
    return matches;
  }
}
