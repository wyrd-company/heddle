// ---
// relationships:
//   enforces: repository-conventions
// ---
import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const sourceRestrictions = {
  "max-lines": [
    "error",
    { max: 300, skipBlankLines: false, skipComments: false },
  ],
  "no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "child_process",
          message: "Service code must use a library instead of shelling out.",
        },
        {
          name: "node:child_process",
          message: "Service code must use a library instead of shelling out.",
        },
      ],
    },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "ImportExpression[source.value='child_process'], ImportExpression[source.value='node:child_process'], CallExpression[callee.name='require'][arguments.0.value='child_process'], CallExpression[callee.name='require'][arguments.0.value='node:child_process']",
      message: "Service code must use a library instead of shelling out.",
    },
  ],
};

export default tseslint.config(
  { ignores: ["coverage/**", "dist/**", "node_modules/**", "spikes/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: sourceRestrictions,
  },
  prettier,
);
