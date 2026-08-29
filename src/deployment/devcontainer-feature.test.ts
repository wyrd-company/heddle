// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const featureDirectory = ".devcontainer/features/heddle";

describe("Heddle devcontainer feature", () => {
  it("declares the persistent-state, port, and DNS options", async () => {
    const manifest = JSON.parse(
      await readFile(`${featureDirectory}/devcontainer-feature.json`, "utf8"),
    ) as {
      options: Record<string, { default: string }>;
      installsAfter: string[];
    };

    expect(manifest.options).toMatchObject({
      boardPath: { default: "/workspaces/kanban" },
      dnsName: { default: "" },
      port: { default: "3774" },
      statePath: { default: "/var/lib/heddle" },
    });
    expect(manifest.installsAfter).toContain(
      "ghcr.io/wyrd-company/devcontainers/caddy",
    );
  });

  it("binds s6, state-mount, installed-package, and Caddy agreements", async () => {
    const common = await readFile(`${featureDirectory}/common.sh`, "utf8");
    const installer = await readFile(`${featureDirectory}/install.sh`, "utf8");

    expect(common).toContain("apt-get install -y --no-install-recommends");
    expect(installer).toContain(
      "ensure_apt_packages build-essential ca-certificates python3",
    );
    expect(installer).toContain('packages=("$(dirname "$0")"/heddle-*.tgz)');
    expect(installer).toContain("--allow-scripts=better-sqlite3");
    expect(installer).toContain('mountpoint -q "\\${state_path}"');
    expect(installer).toContain("export HEDDLE_BOARD_PATH=${quoted_board}");
    expect(installer).toContain(
      "touch /etc/s6-overlay/user-bundles.d/user/contents.d/heddle",
    );
    expect(installer).toContain("cat >/etc/caddy/conf.d/heddle.caddy <<EOF");
    expect(installer).toContain("reverse_proxy 127.0.0.1:${PORT}");
  });

  it("pins qualification and documents every isolation boundary", async () => {
    const versions = JSON.parse(
      await readFile("deployment/supported-versions.json", "utf8"),
    ) as { t3: string };
    const readme = await readFile(`${featureDirectory}/README.md`, "utf8");
    const qualification = await readFile(
      "scripts/deployment/qualify-pinned-t3.mjs",
      "utf8",
    );
    const featureQualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );

    expect(versions.t3).toBe("0.0.36");
    expect(readme).toContain(`supports T3 \`${versions.t3}\``);
    expect(qualification).toContain('t3Binary === "/usr/local/bin/t3"');
    expect(qualification).toContain('t3Binary === "/home/vscode/.t3"');
    expect(qualification).toContain(
      'installedPackage !== "/usr/local/lib/node_modules/heddle"',
    );
    expect(qualification).toContain("port === 3773");
    expect(qualification).toContain("dirname(process.execPath)");
    expect(qualification).toContain("observedVersion !== expectedVersion");
    expect(featureQualification).toContain(
      'git -C "${repository}" diff --quiet',
    );
    expect(featureQualification).toContain(
      '--filter "label=heddle.qualification=${qualification_label}"',
    );
    expect(qualification).toContain(
      "dist/control-plane/t3-control-plane-client.js",
    );
  });
});
