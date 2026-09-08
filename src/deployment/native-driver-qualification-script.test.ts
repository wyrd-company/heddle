// ---
// relationships:
//   verifies: heddle
// ---

import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];
const containerId = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const harness = async (
  options: { omitContainerId?: boolean; wrongLabel?: boolean } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "native-driver-script-"));
  roots.push(root);
  const binaryDirectory = join(root, "bin");
  const log = join(root, "commands.log");
  const label = join(root, "label");
  await mkdir(binaryDirectory, { recursive: true });
  const devcontainer = join(binaryDirectory, "devcontainer");
  await writeFile(
    devcontainer,
    `#!/bin/sh
printf 'devcontainer %s\\n' "$*" >>"$STUB_COMMAND_LOG"
if [ "$1" = up ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --id-label ]; then
      printf '%s' "$2" >"$STUB_LABEL_FILE"
      break
    fi
    shift
  done
  if [ "\${STUB_OMIT_CONTAINER_ID:-0}" = 1 ]; then
    printf '{"outcome":"success"}\\n'
  else
    printf '{"outcome":"success","containerId":"${containerId}"}\\n'
  fi
  exit 0
fi
exit "\${STUB_EXEC_STATUS:-0}"
`,
  );
  const docker = join(binaryDirectory, "docker");
  await writeFile(
    docker,
    `#!/bin/sh
printf 'docker %s\\n' "$*" >>"$STUB_COMMAND_LOG"
case "$1" in
  inspect)
    if [ "${options.wrongLabel ? "1" : "0"}" = 1 ]; then
      printf 'another-owner\\n'
    else
      sed 's/^[^=]*=//' "$STUB_LABEL_FILE"
    fi
    ;;
  ps) printf '${containerId}\\n' ;;
  rm) exit 0 ;;
esac
`,
  );
  const kanban = join(binaryDirectory, "kanban-md");
  await writeFile(kanban, "#!/bin/sh\nexit 0\n");
  await Promise.all(
    [devcontainer, docker, kanban].map((path) => chmod(path, 0o755)),
  );
  return {
    env: {
      ...process.env,
      HEDDLE_DRIVER_KANBAN: kanban,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      STUB_COMMAND_LOG: log,
      STUB_EXEC_STATUS: "17",
      STUB_LABEL_FILE: label,
      STUB_OMIT_CONTAINER_ID: options.omitContainerId ? "1" : "0",
    },
    log,
  };
};

describe("native driver qualification command", () => {
  it("removes the exact owned container when the native row fails", async () => {
    const fixture = await harness();

    await expect(
      execute("scripts/deployment/qualify-native-driver.sh", ["codex"], {
        cwd: process.cwd(),
        env: fixture.env,
      }),
    ).rejects.toMatchObject({ code: 17 });

    const commands = await readFile(fixture.log, "utf8");
    const inspect = commands.indexOf(`docker inspect --format`);
    const remove = commands.indexOf(`docker rm --force ${containerId}`);
    expect(inspect).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(inspect);
  });

  it("refuses cleanup when the exact container lacks the ownership label", async () => {
    const fixture = await harness({ wrongLabel: true });

    await expect(
      execute("scripts/deployment/qualify-native-driver.sh", ["codex"], {
        cwd: process.cwd(),
        env: fixture.env,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(await readFile(fixture.log, "utf8")).not.toContain("docker rm");
  });

  it("recovers the full owned identity when startup omits its result ID", async () => {
    const fixture = await harness({ omitContainerId: true });

    await expect(
      execute("scripts/deployment/qualify-native-driver.sh", ["codex"], {
        cwd: process.cwd(),
        env: fixture.env,
      }),
    ).rejects.toMatchObject({ code: 17 });

    const commands = await readFile(fixture.log, "utf8");
    expect(commands).toContain("docker ps --all --quiet --no-trunc --filter");
    expect(commands).toContain(`docker rm --force ${containerId}`);
  });

  it("keeps the operator command executable", async () => {
    await expect(
      access("scripts/deployment/qualify-native-driver.sh", constants.X_OK),
    ).resolves.toBeUndefined();
  });
});
