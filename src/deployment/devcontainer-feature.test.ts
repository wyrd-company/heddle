// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const featureDirectory = ".devcontainer/features/heddle";
const execute = promisify(execFile);

describe("Heddle devcontainer feature", () => {
  it("declares only the configuration-directory and Caddy routing options", async () => {
    const manifest = JSON.parse(
      await readFile(`${featureDirectory}/devcontainer-feature.json`, "utf8"),
    ) as {
      options: Record<string, { default: string }>;
      installsAfter: string[];
    };

    expect(manifest.options).toMatchObject({
      configDirectory: { default: "/home/vscode/.heddle" },
      dnsName: { default: "" },
    });
    expect(manifest.options).not.toHaveProperty("boardPath");
    expect(manifest.options).not.toHaveProperty("port");
    expect(manifest.options).not.toHaveProperty("statePath");
    expect(manifest.installsAfter).toContain(
      "ghcr.io/wyrd-company/devcontainers/caddy",
    );
  });

  it("binds s6, state-mount, installed-package, and Caddy agreements", async () => {
    const common = await readFile(`${featureDirectory}/common.sh`, "utf8");
    const installer = await readFile(`${featureDirectory}/install.sh`, "utf8");

    expect(common).toContain("apt-get install -y --no-install-recommends");
    expect(installer).toContain(
      "ensure_apt_packages build-essential ca-certificates jq python3",
    );
    expect(installer).toContain('packages=("$(dirname "$0")"/heddle-*.tgz)');
    expect(installer).toContain("--allow-scripts=better-sqlite3");
    expect(installer).toContain(
      [
        "/usr/local/bin/heddle-server \\",
        '    --config "\\${config_directory}" \\',
        "    --print-launch-settings",
      ].join("\n"),
    );
    expect(installer).toContain('mountpoint -q "\\${state_path}"');
    expect(installer).toContain("expected_kanban_version=0.37.0-fork+b9fc380");
    expect(installer).toContain(
      '/usr/local/libexec/heddle/check-kanban-version "\\${expected_kanban_version}"',
    );
    expect(installer).not.toContain("export HEDDLE_BOARD_PATH");
    expect(installer).not.toContain("export HEDDLE_HOST");
    expect(installer).not.toContain("export HEDDLE_PORT");
    expect(installer).not.toContain("export HEDDLE_STATE_PATH");
    expect(installer).toContain(
      [
        "exec s6-setuidgid ${quoted_user} \\",
        '    /usr/local/bin/heddle-server --config "\\${config_directory}"',
      ].join("\n"),
    );
    expect(installer.split("\n")).toContain(
      "touch /etc/s6-overlay/user-bundles.d/user/contents.d/heddle",
    );
    expect(installer).toContain(
      'mv "\\${caddy_temp}" /etc/caddy/conf.d/heddle.caddy',
    );
    expect(installer).toContain('"\\${dns_name}" "\\${host}" "\\${port}"');
  });

  it("requires the complete supported kanban-md version output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heddle-kanban-version-"));
    const fakeKanban = join(directory, "kanban-md");
    await writeFile(
      fakeKanban,
      '#!/bin/sh\nprintf "%s\\n" "$KANBAN_VERSION_OUTPUT"\n',
    );
    await chmod(fakeKanban, 0o755);
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
    };
    const check = `${featureDirectory}/check-kanban-version.sh`;

    try {
      await expect(
        execute(check, ["0.37.0-fork+b9fc380"], {
          env: {
            ...environment,
            KANBAN_VERSION_OUTPUT: "kanban-md version 0.37.0-fork+b9fc380",
          },
        }),
      ).resolves.toMatchObject({ stderr: "" });
      for (const output of [
        "wrapper kanban-md version 0.37.0-fork+b9fc380",
        "kanban-md version 0.37.0-fork+b9fc380-extra",
        "kanban-md version 0.37.0-fork+b9fc380 wrapped",
      ]) {
        await expect(
          execute(check, ["0.37.0-fork+b9fc380"], {
            env: { ...environment, KANBAN_VERSION_OUTPUT: output },
          }),
        ).rejects.toMatchObject({ code: 1 });
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each(["state", "board", "tools", "config"])(
    "cleans scratch resources when the %s allocation fails",
    async (allocation) => {
      const scratchRoot = await mkdtemp(
        join(tmpdir(), "heddle-allocation-failure-"),
      );
      try {
        await expect(
          execute("bash", ["scripts/deployment/qualify-feature.sh"], {
            env: {
              ...process.env,
              HEDDLE_QUALIFICATION_FAIL_ALLOCATION: allocation,
              HEDDLE_QUALIFICATION_SCRATCH_ROOT: scratchRoot,
            },
          }),
        ).rejects.toMatchObject({ code: 1 });
        await expect(readdir(scratchRoot)).resolves.toEqual([]);
      } finally {
        await rm(scratchRoot, { force: true, recursive: true });
      }
    },
  );

  it("pins qualification and documents every isolation boundary", async () => {
    const versions = JSON.parse(
      await readFile("deployment/supported-versions.json", "utf8"),
    ) as { kanbanMd: string; t3: string };
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
    expect(versions.kanbanMd).toBe("0.37.0-fork+b9fc380");
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
      'chmod 0600 "${config_directory}/config.yml"',
    );
    expect(featureQualification).toContain(
      'HEDDLE_QUALIFICATION_CONFIG="${config_directory}"',
    );
    expect(
      featureQualification.match(
        /--filter "label=heddle\.qualification=\$\{qualification_label\}"/g,
      ),
    ).toHaveLength(2);
    expect(qualification).toContain(
      "dist/control-plane/t3-control-plane-client.js",
    );
  });
});
