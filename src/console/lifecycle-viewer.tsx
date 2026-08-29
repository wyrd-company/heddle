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
  type Editor,
  TldrawEditor,
} from "tldraw";
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

function LifecycleViewer() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [snapshot, setSnapshot] = useState<ConsoleLifecycleSnapshot | null>(
    null,
  );
  const bus = useRef(new EventBus());
  const replayedIdentity = useRef("");
  const snapshotRef = useRef<ConsoleLifecycleSnapshot | null>(null);

  useExecutionBridge(editor, bus.current);

  const replace = useCallback((next: ConsoleLifecycleSnapshot) => {
    assertLifecycleReplacement(next);
    replayedIdentity.current = "";
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

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
        replayedIdentity.current = "";
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
  }, [append, replace]);

  useEffect(() => {
    if (editor === null || snapshot === null) return;
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
  }, [editor, snapshot]);

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
            onMount={setEditor}
            shapeUtils={shapeUtils}
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
