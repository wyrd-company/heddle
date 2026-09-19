// ---
// relationships:
//   verifies: command-line-interface
// ---
import sqlite from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { once } from "node:events";

const Database = sqlite.DatabaseSync;
Reflect.set(
  globalThis,
  Symbol.for("service-test-database"),
  class extends Database {
    constructor(...args: ConstructorParameters<typeof Database>) {
      writeFileSync(
        join(
          String(process.env["SERVICE_TEST_ROOT"]),
          `${String(process.pid)}.opened`,
        ),
        "opened",
      );
      super(...args);
    }
  },
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:sqlite")
      return { url: "test:sqlite", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:sqlite")
      return {
        format: "module",
        shortCircuit: true,
        source:
          'export const DatabaseSync = globalThis[Symbol.for("service-test-database")];',
      };
    return next(url, context);
  },
});
process.send?.("ready");
await once(process, "message");
process.disconnect();
