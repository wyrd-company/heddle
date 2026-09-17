// ---
// relationships:
//   implements:
//     - engine-and-run-model
//     - github-binding-and-intake
// ---
import { build } from "esbuild";

await build({
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
  outdir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node24",
});
