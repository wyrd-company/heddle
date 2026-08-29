#!/usr/bin/env bash

set -euo pipefail

expected_version="${1:?expected kanban-md version is required}"
expected_output="kanban-md version ${expected_version}"
observed_output="$(kanban-md --version 2>/dev/null || true)"

[[ "${observed_output}" == "${expected_output}" ]] || {
    echo "[heddle] ERROR: kanban-md ${expected_version} must be on PATH." >&2
    exit 1
}
