// ---
// relationships:
//   implements:
//     - engine-and-run-model
//     - github-binding-and-intake
// ---
import { build } from "esbuild";

const result = await build({
  bundle: true,
  entryPoints: ["src/cli.ts", "src/index.ts"],
  external: [
    "@graphql-typed-document-node/core",
    "@octokit/auth-app",
    "@octokit/core",
    "ajv",
    "flowcraft",
    "graphql",
    "jsonata",
    "nunjucks",
    "yaml",
    "zod",
  ],
  format: "esm",
  metafile: true,
  outdir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node24",
});

const bundledInputs = Object.keys(result.metafile.inputs);
for (const requiredInput of ["src/github/src/", "src/t3code/src/"]) {
  if (!bundledInputs.some((input) => input.includes(requiredInput))) {
    throw new Error(
      `Build did not bundle internal module input: ${requiredInput}`,
    );
  }
}
