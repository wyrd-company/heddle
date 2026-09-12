// ---
// relationships:
//   implements: heddle
// ---

import type Database from "better-sqlite3";

export const replaceCorrelationTokenIndex = (
  database: Database.Database,
  instanceId: string,
  correlationTokens: Readonly<Record<string, string>>,
): void => {
  database
    .prepare("DELETE FROM heddle_correlation_tokens WHERE instance_id = ?")
    .run(instanceId);
  const insert = database.prepare(
    `INSERT INTO heddle_correlation_tokens (token, instance_id, session_key)
     VALUES (?, ?, ?)`,
  );
  for (const [sessionKey, token] of Object.entries(correlationTokens).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    insert.run(token, instanceId, sessionKey);
  }
};

export const deleteCorrelationTokenIndex = (
  database: Database.Database,
  instanceId: string,
): void => {
  database
    .prepare("DELETE FROM heddle_correlation_tokens WHERE instance_id = ?")
    .run(instanceId);
};
