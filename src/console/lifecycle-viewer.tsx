// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowBindingUtil,
  ArrowShapeUtil,
  defaultTools,
  type Editor,
  TldrawEditor,
} from "tldraw";
import type { WorkflowBlueprint } from "flowcraft";
import "tldraw/tldraw.css";
import "./lifecycle-viewer.css";

import { useExecutionBridge } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/runtime/ExecutionBridge";
import { FlowcraftNodeUtil } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/shapes/FlowcraftNodeUtil";
import { EventBus } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/EventBus";
import { FlowcraftSync } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/FlowcraftSync";
import { blueprintToCanvas } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/blueprint-to-canvas";

import type {
  ConsoleLifecycleEvent,
  ConsoleLifecycleSnapshot,
} from "./types.js";
import { projectLifecycleCanvas } from "./lifecycle-canvas-projection.js";
import {
  appendLifecycleSnapshot,
  assertLifecycleReplacement,
  lifecycleTraversalCounts,
} from "./lifecycle-tail.js";

interface LifecycleViewerPort {
  append(snapshot: ConsoleLifecycleSnapshot): void;
  clear(): void;
  replace(snapshot: ConsoleLifecycleSnapshot): void;
}

declare global {
  interface Window {
    heddleLifecycleViewer?: LifecycleViewerPort;
  }
}

let mountedPort: LifecycleViewerPort | undefined;
let pendingReplacement: ConsoleLifecycleSnapshot | undefined;

window.heddleLifecycleViewer = {
  append(snapshot) {
    if (mountedPort === undefined) {
      throw new Error("Lifecycle tail arrived before renderer mount");
    }
    mountedPort.append(snapshot);
  },
  clear() {
    pendingReplacement = undefined;
    mountedPort?.clear();
  },
  replace(snapshot) {
    if (mountedPort === undefined) {
      pendingReplacement = snapshot;
      return;
    }
    mountedPort.replace(snapshot);
  },
};

const bindingUtils = [ArrowBindingUtil];
const shapeUtils = [FlowcraftNodeUtil, ArrowShapeUtil];

const positionsFor = (
  snapshot: ConsoleLifecycleSnapshot,
): Record<string, { x: number; y: number }> => {
  const positions: Record<string, { x: number; y: number }> = {};
  snapshot.blueprint.nodes.forEach(({ id }, index) => {
    positions[id] = { x: index * 300, y: index % 2 === 0 ? 140 : 20 };
  });
  return positions;
};

const asFlowcraftEvent = (event: ConsoleLifecycleEvent) => ({
  payload: event.payload,
  type: event.type,
});

type CanvasPositions = Record<string, { x: number; y: number }>;

interface BlueprintArtifactRevision {
  blobHash: string;
  blueprint: WorkflowBlueprint;
  path: string;
  positions: CanvasPositions;
}

type EditableBlueprint = WorkflowBlueprint & { positions: CanvasPositions };

const responseJson = async <T,>(response: Response): Promise<T> => {
  const value = (await response.json()) as T | { error?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof value === "object" &&
        value !== null &&
        "error" in value &&
        typeof value.error === "string"
        ? value.error
        : `Blueprint request failed (${response.status})`,
    );
  }
  return value as T;
};

function LifecycleViewer() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [snapshot, setSnapshot] = useState<ConsoleLifecycleSnapshot | null>(
    null,
  );
  const [editing, setEditing] = useState<BlueprintArtifactRevision | null>(
    null,
  );
  const [draft, setDraft] = useState<EditableBlueprint | null>(null);
  const [editStatus, setEditStatus] = useState("");
  const [rebaseStatus, setRebaseStatus] = useState("");
  const [rebaseTarget, setRebaseTarget] = useState("");
  const [rebasing, setRebasing] = useState(false);
  const [saving, setSaving] = useState(false);
  const bus = useRef(new EventBus());
  const editRequestGeneration = useRef(0);
  const rebaseRequestGeneration = useRef(0);
  const replayedIdentity = useRef("");
  const snapshotRef = useRef<ConsoleLifecycleSnapshot | null>(null);

  useExecutionBridge(editor, bus.current);

  const resetEditing = useCallback(() => {
    editRequestGeneration.current += 1;
    replayedIdentity.current = "";
    setEditing(null);
    setDraft(null);
    setEditStatus("");
    setSaving(false);
  }, []);

  const resetRebase = useCallback(() => {
    rebaseRequestGeneration.current += 1;
    setRebaseStatus("");
    setRebaseTarget("");
    setRebasing(false);
  }, []);

  const replace = useCallback(
    (next: ConsoleLifecycleSnapshot) => {
      assertLifecycleReplacement(next);
      resetEditing();
      resetRebase();
      snapshotRef.current = next;
      setSnapshot(next);
    },
    [resetEditing, resetRebase],
  );

  const append = useCallback((next: ConsoleLifecycleSnapshot) => {
    const current = snapshotRef.current;
    if (current === null)
      throw new Error("Lifecycle tail arrived before replay");
    const combined = appendLifecycleSnapshot(current, next);
    snapshotRef.current = combined;
    if (
      next.events.length > 0 ||
      current.status !== next.status ||
      current.currentStageIds.join("\u0000") !==
        next.currentStageIds.join("\u0000")
    ) {
      setSnapshot(combined);
    }
  }, []);

  useEffect(() => {
    const port: LifecycleViewerPort = {
      append,
      clear: () => {
        resetEditing();
        resetRebase();
        snapshotRef.current = null;
        setSnapshot(null);
      },
      replace,
    };
    mountedPort = port;
    if (pendingReplacement !== undefined) {
      const replacement = pendingReplacement;
      pendingReplacement = undefined;
      port.replace(replacement);
    }
    return () => {
      if (mountedPort === port) mountedPort = undefined;
    };
  }, [append, replace, resetEditing, resetRebase]);

  useEffect(() => {
    if (editor === null || snapshot === null || editing !== null) return;
    const identity = `${snapshot.instanceId}:${snapshot.blueprint.blobHash}`;
    if (replayedIdentity.current !== identity) {
      const sync = new FlowcraftSync(editor);
      sync.applyBlueprint(snapshot.blueprint as never, positionsFor(snapshot));
      // Keep the primitive explicit at the production integration boundary.
      void blueprintToCanvas;
      for (const event of snapshot.events) {
        bus.current.emit(asFlowcraftEvent(event) as never);
      }
      replayedIdentity.current = identity;
    } else {
      const replayedCount = Number(
        editor.getInstanceState().meta["heddleSequence"] ?? 0,
      );
      for (const event of snapshot.events.filter(
        ({ sequence }) => sequence > replayedCount,
      )) {
        bus.current.emit(asFlowcraftEvent(event) as never);
      }
    }
    editor.updateInstanceState({
      isReadonly: true,
      meta: {
        ...editor.getInstanceState().meta,
        heddleSequence: snapshot.nextSequence,
      },
    });
    projectLifecycleCanvas(editor, snapshot);
    editor.zoomToFit({ animation: { duration: 0 } });
  }, [editing, editor, snapshot]);

  useEffect(() => {
    if (editor === null || editing === null) return;
    const sync = new FlowcraftSync(editor, (blueprint) => {
      const editable = blueprint as EditableBlueprint;
      setDraft({
        ...editable,
        positions: { ...editable.positions },
      });
      setEditStatus("Unsaved canvas changes");
    });
    editor.updateInstanceState({ isReadonly: false });
    sync.applyBlueprint(editing.blueprint, editing.positions);
    sync.startListening();
    editor.zoomToFit({ animation: { duration: 0 } });
    return () => {
      sync.dispose();
    };
  }, [editing, editor]);

  const beginEditing = useCallback(async () => {
    if (snapshot === null) return;
    const generation = ++editRequestGeneration.current;
    setEditStatus("Loading repository artifact…");
    try {
      const revision = await responseJson<BlueprintArtifactRevision>(
        await fetch(
          `/api/blueprints/${encodeURIComponent(snapshot.blueprint.id)}`,
        ),
      );
      if (generation !== editRequestGeneration.current) return;
      setEditing(revision);
      setDraft({ ...revision.blueprint, positions: revision.positions });
      setEditStatus(
        `Editing ${revision.path} · running instance stays pinned to ${snapshot.blueprint.blobHash.slice(0, 12)}`,
      );
    } catch (error) {
      if (generation !== editRequestGeneration.current) return;
      setEditStatus(
        error instanceof Error ? error.message : "Blueprint load failed",
      );
    }
  }, [snapshot]);

  const stopEditing = resetEditing;

  const rebaseTargets = snapshot?.rebase.targetStateIds ?? [];
  const selectedRebaseTarget = rebaseTargets.includes(rebaseTarget)
    ? rebaseTarget
    : (rebaseTargets[0] ?? "");

  const rebaseInstance = useCallback(async () => {
    if (
      snapshot === null ||
      !snapshot.rebase.available ||
      selectedRebaseTarget === "" ||
      editing !== null
    ) {
      return;
    }
    const generation = ++rebaseRequestGeneration.current;
    const expectedTargetBlobHash = snapshot.rebase.targetBlueprintBlobHash;
    setRebasing(true);
    setRebaseStatus(`Rebasing to ${selectedRebaseTarget}…`);
    try {
      const rebased = await responseJson<ConsoleLifecycleSnapshot>(
        await fetch(`/api/lifecycle/${snapshot.taskId}/rebase`, {
          body: JSON.stringify({
            expectedInstanceId: snapshot.instanceId,
            expectedPinnedBlobHash: snapshot.blueprint.blobHash,
            expectedTargetBlobHash,
            targetState: selectedRebaseTarget,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      if (generation !== rebaseRequestGeneration.current) return;
      replace(rebased);
      setRebaseTarget(selectedRebaseTarget);
      setRebaseStatus(
        `Rebased to ${selectedRebaseTarget} · artifact ${rebased.blueprint.blobHash.slice(0, 12)}`,
      );
    } catch (error) {
      if (generation !== rebaseRequestGeneration.current) return;
      setRebaseStatus(
        error instanceof Error ? error.message : "Lifecycle rebase failed",
      );
    } finally {
      if (generation === rebaseRequestGeneration.current) setRebasing(false);
    }
  }, [editing, replace, selectedRebaseTarget, snapshot]);

  const saveEditing = useCallback(async () => {
    if (editing === null || draft === null) return;
    const generation = editRequestGeneration.current;
    setSaving(true);
    setEditStatus("Validating and saving repository artifact…");
    try {
      const revision = await responseJson<BlueprintArtifactRevision>(
        await fetch(
          `/api/blueprints/${encodeURIComponent(editing.blueprint.id)}`,
          {
            body: JSON.stringify({
              edges: draft.edges,
              expectedBlobHash: editing.blobHash,
              nodes: draft.nodes,
              positions: draft.positions,
            }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          },
        ),
      );
      if (generation !== editRequestGeneration.current) return;
      setEditing(revision);
      setDraft({ ...revision.blueprint, positions: revision.positions });
      setEditStatus(
        `Saved ${revision.path} · artifact ${revision.blobHash.slice(0, 12)}`,
      );
    } catch (error) {
      if (generation !== editRequestGeneration.current) return;
      setEditStatus(
        error instanceof Error ? error.message : "Blueprint save failed",
      );
    } finally {
      if (generation === editRequestGeneration.current) setSaving(false);
    }
  }, [draft, editing]);

  const traversals = useMemo(
    () => (snapshot === null ? [] : lifecycleTraversalCounts(snapshot.events)),
    [snapshot],
  );

  return (
    <div className="lifecycle-renderer" data-ready={snapshot !== null}>
      <div
        className="lifecycle-canvas-shell"
        aria-label="Lifecycle graph"
        role="region"
      >
        {snapshot === null ? (
          <p className="lifecycle-empty">
            Select a task lifecycle to render its pinned history.
          </p>
        ) : (
          <TldrawEditor
            bindingUtils={bindingUtils}
            initialState="select"
            onMount={setEditor}
            shapeUtils={shapeUtils}
            tools={defaultTools}
          />
        )}
      </div>
      <aside
        className="lifecycle-history"
        aria-labelledby="lifecycle-history-title"
        tabIndex={0}
      >
        <header>
          <p className="eyebrow">ORDERED EVENT HISTORY</p>
          <h3 id="lifecycle-history-title">Instance events</h3>
          {snapshot === null ? null : (
            <p className="lifecycle-identity">
              {snapshot.instanceId} · {snapshot.blueprint.id} ·{" "}
              {snapshot.status}
            </p>
          )}
          <section
            aria-labelledby="lifecycle-rebase-title"
            className="lifecycle-rebase"
            data-available={snapshot?.rebase.available === true}
          >
            <p className="eyebrow" id="lifecycle-rebase-title">
              INSTANCE REBASE
            </p>
            {snapshot === null ? (
              <p className="lifecycle-rebase-summary">
                Select a running lifecycle to inspect its blueprint version.
              </p>
            ) : snapshot.rebase.available ? (
              <>
                <p className="lifecycle-rebase-summary">
                  NEW BLUEPRINT ·{" "}
                  {snapshot.rebase.targetBlueprintBlobHash.slice(0, 12)}
                </p>
                <div className="lifecycle-rebase-controls">
                  <label htmlFor="lifecycle-rebase-target">Target state</label>
                  <select
                    disabled={editing !== null || rebasing}
                    id="lifecycle-rebase-target"
                    onChange={(event) => setRebaseTarget(event.target.value)}
                    value={selectedRebaseTarget}
                  >
                    {rebaseTargets.map((target) => (
                      <option key={target} value={target}>
                        {target}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={
                      editing !== null ||
                      rebasing ||
                      selectedRebaseTarget === ""
                    }
                    onClick={() => void rebaseInstance()}
                    type="button"
                  >
                    {rebasing ? "REBASING…" : "REBASE INSTANCE"}
                  </button>
                </div>
              </>
            ) : (
              <p className="lifecycle-rebase-summary">
                {snapshot.blueprint.blobHash ===
                snapshot.rebase.targetBlueprintBlobHash
                  ? "PINNED BLUEPRINT IS CURRENT"
                  : "INSTANCE IS NOT AT AN AWAITING STATE"}
              </p>
            )}
            <p
              aria-live="polite"
              className="lifecycle-rebase-status"
              data-error={/failed|invalid|changed|not |cannot|already/i.test(
                rebaseStatus,
              )}
              role="status"
            >
              {rebaseStatus}
            </p>
          </section>
          <div className="blueprint-editor-actions">
            {editing === null ? (
              <button
                disabled={snapshot === null}
                onClick={() => void beginEditing()}
                type="button"
              >
                EDIT BLUEPRINT
              </button>
            ) : (
              <>
                <button
                  disabled={draft === null || saving}
                  onClick={() => void saveEditing()}
                  type="button"
                >
                  {saving ? "SAVING…" : "SAVE ARTIFACT"}
                </button>
                <button disabled={saving} onClick={stopEditing} type="button">
                  CLOSE EDITOR
                </button>
              </>
            )}
          </div>
          <p
            aria-live="polite"
            className="blueprint-editor-status"
            data-error={/failed|invalid|violation|changed since/i.test(
              editStatus,
            )}
            role="status"
          >
            {editStatus}
          </p>
        </header>
        {traversals.length === 0 ? null : (
          <p className="lifecycle-traversals">
            LOOP TRAVERSALS ·{" "}
            {traversals
              .map(({ count, nodeId }) => `${nodeId} ×${count}`)
              .join(" · ")}
          </p>
        )}
        <ol aria-live="polite">
          {snapshot?.events.map((event) => {
            const payload = event.payload as Record<string, unknown>;
            const node =
              typeof payload?.["nodeId"] === "string"
                ? payload["nodeId"]
                : undefined;
            return (
              <li key={event.sequence} data-event-sequence={event.sequence}>
                <span>{String(event.sequence).padStart(3, "0")}</span>
                <strong>{event.type}</strong>
                <small>{node ?? event.executionId}</small>
              </li>
            );
          })}
        </ol>
      </aside>
    </div>
  );
}

const root = document.querySelector("#lifecycle-canvas-root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <LifecycleViewer />
    </StrictMode>,
  );
}
