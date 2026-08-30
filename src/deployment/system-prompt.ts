// ---
// relationships:
//   implements: heddle
// ---

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  builtInSystemPrompt,
  HandoffRenderError,
  type SystemPromptResolver,
} from "../control-plane/index.js";

const overrideFileName = "heddle.md";

export const configurationDirectorySystemPromptResolver = (
  configurationDirectory: string,
): SystemPromptResolver => {
  const overridePath = join(configurationDirectory, overrideFileName);
  return async () => {
    try {
      return await readFile(overridePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return builtInSystemPrompt;
      }
      throw new HandoffRenderError(
        `System prompt override '${overridePath}' cannot be read`,
        error,
      );
    }
  };
};
