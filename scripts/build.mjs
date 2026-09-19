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
    "@modelcontextprotocol/sdk",
    "smol-toml",
    "flowcraft",
    "fs-native-extensions",
    "graphql",
    "jsonata",
    "isomorphic-git",
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
