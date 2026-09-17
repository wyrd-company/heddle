// ---
// relationships:
//   implements:
//     - engine-and-run-model
//     - github-binding-and-intake
// ---
import { build } from "esbuild";
import { resolve } from "node:path";

const result = await build({
  alias: {
    "@wyrd-company/github-work": resolve(
      import.meta.dirname,
      "../../../github-spike/src/index.ts",
    ),
    "@wyrd-company/t3code-client": resolve(
      import.meta.dirname,
      "../../../t3code-client/src/index.ts",
    ),
  },
  bundle: true,
  entryPoints: ["src/cli.ts", "src/index.ts"],
  external: ["ajv", "flowcraft", "jsonata", "nunjucks", "yaml"],
  format: "esm",
  inject: ["scripts/bundle-runtime-inputs.ts"],
  metafile: true,
  outdir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node24",
});

const bundledInputs = Object.keys(result.metafile.inputs);
for (const requiredInput of ["github-spike/src/", "t3code-client/src/"]) {
  if (!bundledInputs.some((input) => input.includes(requiredInput))) {
    throw new Error(`Build did not bundle workspace input: ${requiredInput}`);
  }
}
