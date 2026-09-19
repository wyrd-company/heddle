// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

it("provides SQLite through the supported Node runtime", () => {
  const database = new DatabaseSync(":memory:");

  try {
    expect(database.prepare("select 1 as value").get()).toEqual({ value: 1 });
  } finally {
    database.close();
  }
});
