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

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const featureDirectory = ".devcontainer/features/heddle";
const execute = promisify(execFile);

describe("Heddle devcontainer feature", () => {
  it.each([
    "AGENTS.md",
    "docs/operators/production-composition.md",
    "docs/technical-designs/heddle.yml",
  ])(
    "keeps %s aligned with the approved supported T3 release",
    async (path) => {
      const versions = JSON.parse(
        await readFile("deployment/supported-versions.json", "utf8"),
      );
      const document = await readFile(path, "utf8");
      expect(document).toContain(versions.t3);
      expect(document.match(/0\.0\.\d+-wyrd\.\d+/g)).toEqual([versions.t3]);
    },
  );
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
    expect(installer).toContain(
      '"$(dirname "$0")/verify-feature-source.sh" "$(dirname "$0")"',
    );
    expect(installer).toContain(
      'source_directory="$(dirname "$0")/heddle-source"',
    );
    expect(installer).not.toContain(
      'packages=("$(dirname "$0")"/heddle-*.tgz)',
    );
    expect(installer).toContain("--allow-scripts=better-sqlite3");
    expect(installer).toContain(
      [
        "/usr/local/bin/heddle-server \\",
        '    --config "\\${config_directory}" \\',
        "    --print-launch-settings",
      ].join("\n"),
    );
    expect(installer).toContain('mountpoint -q "\\${state_path}"');
    expect(installer).toContain(
      'state_path="\\$(jq -er \'.stateDirectory\' <<<"\\${launch_settings}")"',
    );
    expect(installer).toContain(
      'host="\\$(jq -er \'.host\' <<<"\\${launch_settings}")"',
    );
    expect(installer).toContain(
      'port="\\$(jq -er \'.port\' <<<"\\${launch_settings}")"',
    );
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
    expect(installer).toContain(
      "timeout --signal=TERM --kill-after=1 10 \\\n" +
        "        bash -c 'until /usr/local/bin/caddy-reload >/dev/null 2>&1; do sleep 0.1; done'",
    );
    expect(installer).toContain(
      "Caddy did not accept the configured Heddle endpoint.",
    );
    expect(installer).toContain('"\\${dns_name}" "\\${host}" "\\${port}"');
    expect(installer).not.toContain("reverse_proxy 127.0.0.1:");
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

  it.each(["state", "board", "tools", "config", "publication"])(
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
    ) as { kanbanMd: string; t3: string; t3PackageSource: string };
    const readme = await readFile(`${featureDirectory}/README.md`, "utf8");
    const qualification = await readFile(
      "scripts/deployment/qualify-pinned-t3.mjs",
      "utf8",
    );
    const featureQualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );

    expect(versions.t3).toBe("0.0.38-wyrd.2");
    expect(versions.t3PackageSource).toBe(
      "https://github.com/wyrd-company/t3code/releases/download/server/0.0.38-wyrd.2/t3-0.0.38-wyrd.2.tgz",
    );
    expect(versions.kanbanMd).toBe("0.37.0-fork+b9fc380");
    expect(readme).toContain(
      `supports the Wyrd Company T3 fork \`${versions.t3}\``,
    );
    expect(featureQualification).toContain("jq -er '.t3PackageSource'");
    expect(featureQualification).toContain(
      "npm install --global --no-audit --no-fund --prefix",
    );
    expect(featureQualification).toContain("HEDDLE_T3_BINARY=");
    expect(featureQualification).toContain("${prefix}/bin/t3");
    expect(qualification).toContain('t3Binary === "/usr/local/bin/t3"');
    expect(qualification).toContain("registerWorkflowMcpProviderSession");
    expect(qualification).toContain('t3Binary === "/home/vscode/.t3"');
    expect(qualification).toContain(
      'installedPackage !== "/usr/local/lib/node_modules/heddle"',
    );
    expect(qualification).toContain("port === 3773");
    expect(qualification).toContain("dirname(process.execPath)");
    expect(qualification).toContain("observedVersion !== expectedVersion");
    expect(qualification).toContain("match(/^t3 v(\\S+)$/)?.[1]");
    expect(featureQualification).toContain(
      'git -C "${repository}" diff --quiet',
    );
    expect(featureQualification).toContain(
      'chmod 0600 "${config_directory}/config.yml"',
    );
    expect(featureQualification).toContain(
      'published_feature_reference="ghcr.io/wyrd-company/heddle/heddle:1"',
    );
    expect(featureQualification).toContain("devcontainer features publish");
    expect(featureQualification).toContain("--namespace wyrd-company/heddle");
    expect(featureQualification).toContain(
      'dry_published_reference="localhost:${registry_port}/wyrd-company/heddle/heddle:1"',
    );
    expect(featureQualification).toContain(
      'HEDDLE_QUALIFICATION_CONFIG="${config_directory}"',
    );
    expect(
      featureQualification.match(/DOCKER_CONFIG="\$\{docker_config\}"/g),
    ).toHaveLength(2);
    expect(featureQualification).toContain("remove_owned_container() {");
    expect(featureQualification).toContain(
      "Refusing to remove container ${full_id}",
    );
    expect(featureQualification).toContain(
      "Removing verified qualification container %s label=%s=%s",
    );
    expect(featureQualification).toContain(
      "persistence.writeReconcilerRuntime({",
    );
    expect(featureQualification).toContain(
      'blueprintPath: "blueprints/qualification.json",',
    );
    expect(featureQualification).toContain("pendingTransition: null,");
    expect(featureQualification).toContain(
      'stageId: "inspect",\n  state: "waiting",',
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

  it("keeps the deployment qualification fixture aligned with the production schema", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );
    const fixture = qualification.match(
      /cat >"\$\{config_directory\}\/config\.yml" <<'EOF'\n(?<yaml>[\s\S]*?)\nEOF/u,
    )?.groups?.["yaml"];
    expect(
      fixture,
      "deployment qualification config fixture is missing",
    ).toBeDefined();

    const configuration = parse(
      fixture!.replace("T3_MOCK_PORT", "3999"),
    ) as object;
    const schema = JSON.parse(
      await readFile("schemas/production-configuration.json", "utf8"),
    );
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
    }).compile(schema);

    expect(
      validate(configuration),
      `deployment qualification config violates the production schema: ${JSON.stringify(validate.errors)}`,
    ).toBe(true);

    const themeFixture = qualification.match(
      /cat >"\$\{config_directory\}\/blueprints\/themes\/sample-team\.yml" <<'EOF'\n(?<yaml>[\s\S]*?)\nEOF/u,
    )?.groups?.["yaml"];
    expect(
      themeFixture,
      "deployment qualification agent-name theme fixture is missing",
    ).toBeDefined();
    const themeSchema = JSON.parse(
      await readFile("schemas/agent-name-theme.json", "utf8"),
    );
    const validateTheme = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(themeSchema);
    expect(
      validateTheme(parse(themeFixture!)),
      `deployment qualification theme violates the agent-name theme schema: ${JSON.stringify(validateTheme.errors)}`,
    ).toBe(true);

    const fixturePreflight = qualification.indexOf(
      "await themeCatalog.validateCurrent();",
    );
    const packageGate = qualification.indexOf(
      'task -d "${repository}" deployment:package',
    );
    expect(fixturePreflight).toBeGreaterThan(-1);
    expect(fixturePreflight).toBeLessThan(packageGate);
  });

  it("routes every qualification container removal through verified identity", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );
    const helperStart = qualification.indexOf("remove_owned_container() {");
    const helperEnd = qualification.indexOf("\ncleanup() {", helperStart);
    const removalInvocations = [
      ...qualification.matchAll(/^\s*docker rm --force /gm),
    ];

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(removalInvocations).toHaveLength(1);
    expect(removalInvocations[0]?.index).toBeGreaterThan(helperStart);
    expect(removalInvocations[0]?.index).toBeLessThan(helperEnd);
    expect(qualification).toContain(
      [
        "remove_owned_container \\",
        '    "${container_id}" \\',
        "    heddle.qualification",
      ].join("\n"),
    );
  });

  it("provisions the derived qualification clone with an origin upstream", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );

    expect(qualification).toContain(
      'git clone "${config_directory}/blueprints-origin.git" "${config_directory}/blueprints"',
    );
    expect(qualification).toContain(
      'git -C "${config_directory}/blueprints" remote set-url origin ../blueprints-origin.git',
    );
    expect(qualification).toContain(
      'git -C "${config_directory}/blueprints" push --set-upstream origin main',
    );
  });

  it("creates the nested artifact directory inside the generated blueprint repository", async () => {
    const qualification = await readFile(
      "scripts/deployment/qualify-feature.sh",
      "utf8",
    );
    const clone = qualification.indexOf(
      'git clone "${config_directory}/blueprints-origin.git" "${config_directory}/blueprints"',
    );
    const artifactDirectory = qualification.indexOf(
      'install -d -m 0755 "${config_directory}/blueprints/blueprints"',
    );
    const packageGate = qualification.indexOf(
      'task -d "${repository}" deployment:package',
    );

    expect(clone).toBeGreaterThan(-1);
    expect(artifactDirectory).toBeGreaterThan(clone);
    expect(artifactDirectory).toBeLessThan(packageGate);
  });
});
