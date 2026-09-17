// ---
// relationships:
//   implements:
//     - github-client
//     - github-binding-and-intake
// ---
import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  schema: "src/github/schema/github.graphql",
  documents: ["src/github/src/**/*.ts", "!src/github/src/generated/**"],
  ignoreNoDocuments: true,
  generates: {
    "src/github/src/generated/": {
      preset: "client",
      presetConfig: { fragmentMasking: false },
      config: {
        emitLegacyCommonJSImports: false,
        useTypeImports: true,
        enumsAsTypes: true,
        skipTypename: false,
        scalars: {
          Date: "string",
          DateTime: "string",
          GitObjectID: "string",
          URI: "string",
          HTML: "string",
          BigInt: "string",
          Base64String: "string",
          GitSSHRemote: "string",
          GitTimestamp: "string",
          PreciseDateTime: "string",
          X509Certificate: "string",
        },
      },
    },
  },
};

export default config;
