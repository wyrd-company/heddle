#!/usr/bin/env bash

set -euo pipefail

# ---
# relationships:
#   verifies: package.json
# ---

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
scratch_directory="$(mktemp -d)"

cleanup() {
    rm -rf "${scratch_directory}"
}
trap cleanup EXIT

package_directory="${scratch_directory}/package"
consumer_directory="${scratch_directory}/consumer"
mkdir -p "${package_directory}" "${consumer_directory}"

npm pack --silent --pack-destination "${package_directory}" "${repository_root}" >/dev/null
mapfile -t package_paths < <(
    find "${package_directory}" -maxdepth 1 -type f \
        -name 'wyrd-company-heddle-*.tgz' -print
)
[ "${#package_paths[@]}" -eq 1 ]

if tar -tzf "${package_paths[0]}" | grep -Eq '(^|/)\.\.(/|$)'; then
    printf 'packed archive contains a parent-directory traversal\n' >&2
    exit 1
fi
if tar -tvzf "${package_paths[0]}" | awk '$1 ~ /^l/ { found = 1 } END { exit !found }'; then
    printf 'packed archive contains a symbolic link\n' >&2
    exit 1
fi

(
    cd "${consumer_directory}"
    npm install --silent --ignore-scripts --no-audit --no-fund "${package_paths[0]}"
)

help_output="$("${consumer_directory}/node_modules/.bin/heddle" --help)"
for command_name in start validate skill hook; do
    grep -q "${command_name}" <<<"${help_output}"
done
(
    cd "${consumer_directory}"
    node --input-type=module <<'EOF'
const heddle = await import("@wyrd-company/heddle");
if (typeof heddle.github.github !== "function") {
  throw new Error("packed package does not expose the GitHub client namespace");
}
if (typeof heddle.t3code.T3Client !== "function") {
  throw new Error("packed package does not expose the T3 Code client namespace");
}
EOF
)

node --input-type=module - "${package_paths[0]}" <<'EOF'
import { execFileSync } from "node:child_process";

const packagePath = process.argv[2];
const manifest = JSON.parse(
  execFileSync("tar", ["-xOf", packagePath, "package/package.json"], {
    encoding: "utf8",
  }),
);

if (manifest.bin?.heddle !== "./dist/cli.js") {
  throw new Error("packed manifest does not expose the Heddle executable");
}
if (manifest.publishConfig?.registry !== "https://npm.pkg.github.com") {
  throw new Error("packed manifest does not target GitHub Packages");
}
if (manifest.publishConfig?.access !== "restricted") {
  throw new Error("packed manifest is not restricted for the private phase");
}
for (const section of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  for (const [name, specification] of Object.entries(manifest[section] ?? {})) {
    if (String(specification).startsWith("file:")) {
      throw new Error(`packed manifest exposes file dependency ${name}`);
    }
  }
}
EOF
