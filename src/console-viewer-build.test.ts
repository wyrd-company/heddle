// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "vite";
import { expect, it } from "vitest";

it("builds identical console artifacts with local and symlinked dependencies", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "viewer-build-"));
  try {
    const dependencies = join(scratch, "dependency-store", "node_modules");
    const recipePackage = join(dependencies, "recipe-data");
    await mkdir(recipePackage, { recursive: true });
    await writeFile(
      join(recipePackage, "package.json"),
      JSON.stringify({
        name: "recipe-data",
        type: "module",
        exports: "./index.js",
      }),
    );
    await writeFile(
      join(recipePackage, "index.js"),
      'import "./style.css"; export const ingredients = ["flour", "water"];\n',
    );
    await writeFile(
      join(recipePackage, "style.css"),
      ".recipe { color: brown; }\n",
    );

    const artifacts = [];
    for (const layout of ["local", "linked"]) {
      const root = join(scratch, "checkout");
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "recipe-viewer", type: "module" }),
      );
      await writeFile(
        join(root, "src", "entry.ts"),
        'export { ingredients } from "recipe-data";\n',
      );
      if (layout === "local") {
        await cp(dependencies, join(root, "node_modules"), { recursive: true });
      } else {
        await rm(join(root, "node_modules"), { recursive: true });
        await symlink(dependencies, join(root, "node_modules"), "dir");
      }
      expect(await realpath(join(root, "node_modules"))).toBe(
        layout === "local" ? join(root, "node_modules") : dependencies,
      );
      const result = await build({
        configFile: resolve("vite.config.ts"),
        root,
        logLevel: "silent",
        build: {
          lib: { entry: join(root, "src", "entry.ts") },
          outDir: join(root, "output"),
          write: false,
        },
      });
      if ("on" in result) throw new Error("Unexpected watch build");
      artifacts.push(
        (Array.isArray(result) ? result : [result]).flatMap(({ output }) =>
          output.map((file) => ({
            name: file.fileName,
            content: file.type === "chunk" ? file.code : String(file.source),
          })),
        ),
      );
    }
    expect(artifacts[0]?.map(({ name }) => name).sort()).toEqual([
      "lifecycle.css",
      "lifecycle.js",
    ]);
    expect(artifacts[1]).toEqual(artifacts[0]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);
