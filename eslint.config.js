// ---
// relationships:
//   enforces: AGENTS.md
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
        "Literal[value=/^(node:)?child_process$/], TemplateElement[value.cooked=/^(node:)?child_process$/]",
      message: "Service code must use a library instead of shelling out.",
    },
  ],
};

// This syntax guard rejects every statically spelled child_process specifier.
// Computed specifiers are outside the reach of syntax-only lint.

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
