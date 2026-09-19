// ---
// relationships:
//   verifies: agent-tools
// ---
import { join } from "node:path";

// Qualification receivers use an explicit endpoint, independent of the
// scenario's database path. Native harnesses inherit this same selection.
export function fixtureHookEnvironment(root) {
  return {
    HEDDLE_STATE_DIR: root,
    HEDDLE_HOOK_SOCKET: join(root, "fixture-hooks.sock"),
  };
}
