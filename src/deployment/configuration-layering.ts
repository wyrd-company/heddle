// ---
// relationships:
//   implements: heddle
// ---

export type ConfigurationProvenance = Readonly<Record<string, string>>;

export type ConfigurationLayer = {
  readonly source: string;
  readonly value: unknown;
};

export type LayeredConfiguration = {
  readonly clearedBy: ConfigurationProvenance;
  readonly provenance: ConfigurationProvenance;
  readonly value: unknown;
};

export const builtInDeploymentConfiguration = {
  adHocProject: { workspaceRoot: "/workspaces" },
  boardDirectory: "/workspaces/kanban",
  pacing: { providerBudgets: {}, usageWindowHours: 5 },
  pushover: { apiUrl: "https://api.pushover.net/1/messages.json" },
  server: { port: 3774 },
  session: {
    interactionMode: "default",
    worktreesRoot: "/workspaces/worktrees",
  },
  stateDirectory: "/var/lib/heddle",
  t3: { baseUrl: "http://127.0.0.1:3773" },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escapePointerSegment = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

const childPointer = (parent: string, segment: string): string =>
  `${parent}/${escapePointerSegment(segment)}`;

const clone = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, clone(child)]),
    );
  }
  return value;
};

const removeSubtree = (
  values: Record<string, string>,
  pointer: string,
): void => {
  for (const key of Object.keys(values)) {
    if (key === pointer || key.startsWith(`${pointer}/`)) delete values[key];
  }
};

const recordTree = (
  value: unknown,
  pointer: string,
  source: string,
  provenance: Record<string, string>,
): void => {
  provenance[pointer] = source;
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      recordTree(
        child,
        childPointer(pointer, String(index)),
        source,
        provenance,
      ),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      recordTree(child, childPointer(pointer, key), source, provenance);
    }
  }
};

const valueAtPointer = (root: unknown, pointer: string): unknown => {
  if (pointer === "") return root;
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    if (!isRecord(value)) return undefined;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
};

const applyObject = (
  current: unknown,
  overlay: Record<string, unknown>,
  pointer: string,
  source: string,
  builtIns: unknown,
  provenance: Record<string, string>,
  clearedBy: Record<string, string>,
): Record<string, unknown> => {
  const result = isRecord(current)
    ? (clone(current) as Record<string, unknown>)
    : {};
  provenance[pointer] = source;
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const child = childPointer(pointer, key);
    if (overlayValue === null) {
      removeSubtree(provenance, child);
      removeSubtree(clearedBy, child);
      clearedBy[child] = source;
      const fallback = valueAtPointer(builtIns, child);
      if (fallback === undefined) {
        delete result[key];
      } else {
        result[key] = clone(fallback);
        recordTree(result[key], child, "built-in", provenance);
      }
      continue;
    }
    removeSubtree(clearedBy, child);
    if (isRecord(overlayValue)) {
      result[key] = applyObject(
        result[key],
        overlayValue,
        child,
        source,
        builtIns,
        provenance,
        clearedBy,
      );
      continue;
    }
    result[key] = clone(overlayValue);
    removeSubtree(provenance, child);
    recordTree(result[key], child, source, provenance);
  }
  return result;
};

export const layerConfiguration = (
  layers: readonly ConfigurationLayer[],
): LayeredConfiguration => {
  const builtIns = clone(builtInDeploymentConfiguration);
  const provenance: Record<string, string> = {};
  const clearedBy: Record<string, string> = {};
  recordTree(builtIns, "", "built-in", provenance);
  let value: unknown = builtIns;
  for (const layer of layers) {
    if (layer.value === null) {
      value = clone(builtIns);
      for (const key of Object.keys(provenance)) delete provenance[key];
      recordTree(value, "", "built-in", provenance);
      clearedBy[""] = layer.source;
    } else if (isRecord(layer.value)) {
      value = applyObject(
        value,
        layer.value,
        "",
        layer.source,
        builtIns,
        provenance,
        clearedBy,
      );
    } else {
      value = clone(layer.value);
      for (const key of Object.keys(provenance)) delete provenance[key];
      recordTree(value, "", layer.source, provenance);
    }
  }
  return { clearedBy, provenance, value };
};

export const sourceForConfigurationPointer = (
  pointer: string,
  layered: Pick<LayeredConfiguration, "clearedBy" | "provenance">,
): string => {
  let candidate = pointer;
  for (;;) {
    const source =
      layered.clearedBy[candidate] ?? layered.provenance[candidate];
    if (source !== undefined) return source;
    if (candidate === "") return "effective configuration";
    candidate = candidate.slice(0, candidate.lastIndexOf("/"));
  }
};

export const completeConfigurationProvenance = (
  value: unknown,
  provenance: ConfigurationProvenance,
): ConfigurationProvenance => {
  const completed = { ...provenance };
  const defaults: Record<string, string> = {};
  recordTree(value, "", "built-in", defaults);
  for (const [pointer, source] of Object.entries(defaults)) {
    completed[pointer] ??= source;
  }
  return completed;
};
