// ---
// relationships:
//   implements: agent-tools
// ---
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import pluginContracts from "./plugin-contracts.json" with { type: "json" };

export const HOOK_PLUGIN_FILES = pluginContracts;

/** Export reusable native packages. Native harness installers own profile edits. */
export async function exportHookPlugins(
  directory: string,
  version = packageMetadata.version,
): Promise<void> {
  for (const harness of ["claude", "codex"] as const) {
    const plugin = join(directory, harness, "plugins", "heddle");
    const manifest = join(plugin, `.${harness}-plugin`);
    await mkdir(manifest, { recursive: true });
    await mkdir(join(plugin, "hooks"), { recursive: true });
    await writeJson(join(manifest, "plugin.json"), {
      name: "heddle",
      version,
      description:
        "Apply the active Heddle pass policy to this harness session.",
      author: { name: "Wyrd Company" },
      ...(harness === "codex"
        ? {
            interface: {
              displayName: "Heddle",
              shortDescription: "Apply the active pass policy at turn end.",
              developerName: "Wyrd Company",
              category: "Productivity",
              longDescription:
                "Correlate native sessions with active Heddle passes. Other sessions remain unaffected.",
              capabilities: [],
              defaultPrompt: [],
            },
          }
        : {}),
    });
    await writeJson(join(plugin, "hooks", "hooks.json"), {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: `heddle hook stop ${harness}` },
            ],
          },
        ],
      },
    });
    const catalog = join(
      directory,
      harness,
      harness === "claude" ? ".claude-plugin" : ".agents/plugins",
    );
    await mkdir(catalog, { recursive: true });
    await writeJson(
      join(catalog, "marketplace.json"),
      harness === "claude"
        ? {
            name: "heddle",
            owner: { name: "Heddle" },
            plugins: [{ name: "heddle", source: "./plugins/heddle" }],
          }
        : {
            name: "heddle",
            interface: { displayName: "Heddle" },
            plugins: [
              {
                name: "heddle",
                source: { source: "local", path: "./plugins/heddle" },
                policy: {
                  installation: "AVAILABLE",
                  authentication: "ON_INSTALL",
                },
                category: "Productivity",
              },
            ],
          },
    );
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
