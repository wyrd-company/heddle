#!/usr/bin/env node

// ---
// relationships:
//   implements: heddle
// ---

import process from "node:process";

import { validateBlueprintRepository } from "../dist/engine/index.js";

const [repositoryRoot, ...extra] = process.argv.slice(2);
if (repositoryRoot === undefined || extra.length > 0) {
  throw new Error(
    "Usage: validate-blueprints.mjs <blueprints-repository-root>",
  );
}
const artifacts = await validateBlueprintRepository(repositoryRoot);
process.stdout.write(`${JSON.stringify({ artifacts })}\n`);
