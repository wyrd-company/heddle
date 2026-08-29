// ---
// relationships:
//   implements: heddle
// ---

import type {
  EventRow,
  InstanceState,
  JsonValue,
  PersistedEvent,
} from "./types.js";

export const parseEvent = (row: EventRow): PersistedEvent => ({
  instanceId: row.instance_id,
  payload: JSON.parse(row.payload_json) as JsonValue,
  recordedAt: row.recorded_at,
  sequence: row.sequence,
  type: row.type,
});

export const parseState = (serialized: string): InstanceState =>
  JSON.parse(serialized) as InstanceState;
