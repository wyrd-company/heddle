// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const artifactHeader = `// ---\n// relationships:\n//   implements: heddle\n//   references: flowcraft-gate\n// ---\n`;
const stylesheetArtifactHeader = `/* ---\nrelationships:\n  implements: heddle\n  references: flowcraft-gate\n--- */\n`;

export default defineConfig({
  build: {
    assetsDir: ".",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/console/lifecycle-viewer.tsx"),
      fileName: () => "lifecycle.js",
      formats: ["es"],
    },
    outDir: resolve(import.meta.dirname, "assets/console-viewer"),
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "lifecycle.css" : "[name][extname]",
      },
    },
  },
  plugins: [
    react(),
    {
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            output.code = artifactHeader + output.code;
          } else if (output.fileName.endsWith(".css")) {
            output.source = stylesheetArtifactHeader + String(output.source);
          }
        }
      },
      name: "artifact-relationships",
    },
  ],
});
