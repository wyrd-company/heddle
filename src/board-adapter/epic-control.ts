// ---
// relationships:
//   implements: heddle
// ---

export const EPIC_CONTROL_BY_STATUS = {
  backlog: "start",
  todo: "start",
  "in-progress": "pause",
  uat: "pause",
  done: "none",
} as const;

export type EpicControl =
  (typeof EPIC_CONTROL_BY_STATUS)[keyof typeof EPIC_CONTROL_BY_STATUS];

export const epicControlForStatus = (status: string): EpicControl =>
  Object.hasOwn(EPIC_CONTROL_BY_STATUS, status)
    ? EPIC_CONTROL_BY_STATUS[status as keyof typeof EPIC_CONTROL_BY_STATUS]
    : "none";
