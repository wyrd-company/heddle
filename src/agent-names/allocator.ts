// ---
// relationships:
//   implements: heddle
// ---

import type {
  AgentNameAssignmentState,
  IncidentRuntimeRecord,
  InstanceRecord,
  InstanceState,
  ReconcilerRuntimeRecord,
} from "../persistence/index.js";
import {
  type AgentNameListName,
  AgentNameCatalogError,
  type AgentNameTheme,
  type AgentNameThemeKind,
  type GitAgentNameThemeCatalog,
  namesForThemeList,
} from "./theme-catalog.js";

export interface AgentNameAllocationStore {
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ): InstanceRecord | undefined;
  getInstance(instanceId: string): InstanceRecord | undefined;
  listIncidentRuntime(): IncidentRuntimeRecord[];
  listInstances(): InstanceRecord[];
  listReconcilerRuntime(): ReconcilerRuntimeRecord[];
}

const assignmentState = (record: InstanceRecord): AgentNameAssignmentState => {
  const state = record.state.agentNames;
  if (state === undefined) {
    throw new AgentNameCatalogError(
      `Instance ${JSON.stringify(record.instanceId)} has no agent-name theme`,
    );
  }
  return state;
};

const themeFor = (
  themes: readonly AgentNameTheme[],
  state: AgentNameAssignmentState,
): AgentNameTheme => {
  const theme = themes.find(({ id }) => id === state.themeId);
  if (theme === undefined || theme.kind !== state.kind) {
    throw new AgentNameCatalogError(
      `Agent-name theme ${JSON.stringify(state.themeId)} is absent from pinned catalog ${JSON.stringify(state.catalogCommit)}`,
    );
  }
  return theme;
};

export class AgentNameAllocator {
  private serialized: Promise<void> = Promise.resolve();

  public constructor(
    private readonly catalog: GitAgentNameThemeCatalog,
    private readonly store: AgentNameAllocationStore,
  ) {}

  validateCurrent(): ReturnType<GitAgentNameThemeCatalog["validateCurrent"]> {
    return this.catalog.validateCurrent();
  }

  prepareTask(
    instanceId: string,
    kind: AgentNameThemeKind,
  ): Promise<AgentNameAssignmentState> {
    return this.serialize(async () => {
      const existing = this.store.getInstance(instanceId);
      if (existing === undefined) {
        throw new Error(`Instance does not exist: ${instanceId}`);
      }
      if (existing.state.agentNames !== undefined) {
        if (existing.state.agentNames.kind !== kind) {
          throw new AgentNameCatalogError(
            `Instance ${JSON.stringify(instanceId)} already uses a ${existing.state.agentNames.kind} agent-name theme`,
          );
        }
        return existing.state.agentNames;
      }

      const snapshot = await this.catalog.validateCurrent();
      const eligible = snapshot.themes.filter((theme) => theme.kind === kind);
      if (eligible.length === 0) {
        throw new AgentNameCatalogError(
          `Agent-name catalog ${JSON.stringify(snapshot.commit)} has no ${kind} theme`,
        );
      }
      const used = this.store
        .listInstances()
        .filter((record) => record.state.agentNames?.kind === kind).length;
      const selected = eligible[used % eligible.length]!;
      const prepared: AgentNameAssignmentState = {
        assignments: {},
        catalogCommit: snapshot.commit,
        kind,
        themeId: selected.id,
      };
      return this.update(instanceId, (state) => ({
        ...state,
        agentNames: prepared,
      })).state.agentNames!;
    });
  }

  assign(instanceId: string, list: AgentNameListName): Promise<string> {
    return this.serialize(async () => {
      const record = this.store.getInstance(instanceId);
      if (record === undefined) {
        throw new Error(`Instance does not exist: ${instanceId}`);
      }
      const state = assignmentState(record);
      const existing = state.assignments[list];
      if (existing !== undefined) return existing;

      const themes = await this.catalog.read(state.catalogCommit);
      const theme = themeFor(themes, state);
      const names = namesForThemeList(theme, list);
      if (names === undefined) {
        throw new AgentNameCatalogError(
          `Agent-name list ${JSON.stringify(list)} does not exist in ${state.kind} theme ${JSON.stringify(state.themeId)}`,
        );
      }
      const locked = this.lockedNames();
      const priorAssignments = this.store
        .listInstances()
        .filter(
          (candidate) =>
            candidate.state.agentNames?.themeId === state.themeId &&
            candidate.state.agentNames.assignments[list] !== undefined,
        ).length;
      const selected = Array.from(
        { length: names.length },
        (_, offset) => names[(priorAssignments + offset) % names.length]!,
      ).find((name) => !locked.has(name));
      if (selected === undefined) {
        throw new AgentNameCatalogError(
          `Every agent name in ${JSON.stringify(state.themeId)} list ${JSON.stringify(list)} is locked by a running task`,
        );
      }
      return assignmentState(
        this.update(instanceId, (current) => {
          const currentAgentNames = current.agentNames;
          if (currentAgentNames === undefined) {
            throw new AgentNameCatalogError(
              `Instance ${JSON.stringify(instanceId)} lost its agent-name theme during allocation`,
            );
          }
          return {
            ...current,
            agentNames: {
              ...currentAgentNames,
              assignments: {
                ...currentAgentNames.assignments,
                [list]: selected,
              },
            },
          };
        }),
      ).assignments[list]!;
    });
  }

  private lockedNames(): Set<string> {
    const active = new Set([
      ...this.store
        .listReconcilerRuntime()
        .filter(({ state }) => state !== "done")
        .map(({ instanceId }) => instanceId),
      ...this.store
        .listIncidentRuntime()
        .filter(({ state }) => state !== "done")
        .map(({ incidentId }) => incidentId),
    ]);
    return new Set(
      this.store
        .listInstances()
        .filter(({ instanceId }) => active.has(instanceId))
        .flatMap(({ state }) =>
          Object.values(state.agentNames?.assignments ?? {}),
        ),
    );
  }

  private update(
    instanceId: string,
    mutate: (state: InstanceState) => InstanceState,
  ): InstanceRecord {
    for (;;) {
      const current = this.store.getInstance(instanceId);
      if (current === undefined) {
        throw new Error(`Instance does not exist: ${instanceId}`);
      }
      const updated = this.store.compareAndSwapInstance(
        instanceId,
        current.version,
        mutate(current.state),
      );
      if (updated !== undefined) return updated;
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serialized.then(action, action);
    this.serialized = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
