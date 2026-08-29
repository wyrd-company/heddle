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
import { Tldraw, defaultShapeUtils, type Editor, type TLShapeId } from "tldraw";
import "tldraw/tldraw.css";
import "./lifecycle-viewer.css";

import { useExecutionBridge } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/runtime/ExecutionBridge";
import { FlowcraftNodeUtil } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/shapes/FlowcraftNodeUtil";
import { FLOWCRAFT_NODE } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/shapes/types";
import { EventBus } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/EventBus";
import { FlowcraftSync } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/FlowcraftSync";
import { blueprintToCanvas } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/sync/blueprint-to-canvas";

import type {
  ConsoleLifecycleEvent,
  ConsoleLifecycleSnapshot,
} from "./types.js";

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

const shapeUtils = [FlowcraftNodeUtil, ...defaultShapeUtils];

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

const applyCurrentStages = (
  editor: Editor,
  snapshot: ConsoleLifecycleSnapshot,
): void => {
  const current = new Set(snapshot.currentStageIds);
  for (const { id } of snapshot.blueprint.nodes) {
    const shapeId = `shape:${id}` as TLShapeId;
    const shape = editor.getShape(shapeId);
    if (shape?.type !== FLOWCRAFT_NODE) continue;
    editor.updateShape({
      id: shapeId,
      props: { status: current.has(id) ? "pending" : shape.props.status },
      type: FLOWCRAFT_NODE,
    });
  }
};

const traversalCounts = (
  events: ConsoleLifecycleEvent[],
): Array<{ count: number; nodeId: string }> => {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (
      event.type !== "node:start" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload) ||
      typeof event.payload["nodeId"] !== "string"
    ) {
      continue;
    }
    const nodeId = event.payload["nodeId"];
    counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([nodeId, count]) => ({ count, nodeId }));
};

function LifecycleViewer() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [snapshot, setSnapshot] = useState<ConsoleLifecycleSnapshot | null>(
    null,
  );
  const bus = useRef(new EventBus());
  const replayedIdentity = useRef("");

  useExecutionBridge(editor, bus.current);

  const replace = useCallback((next: ConsoleLifecycleSnapshot) => {
    replayedIdentity.current = "";
    setSnapshot(next);
  }, []);

  const append = useCallback((next: ConsoleLifecycleSnapshot) => {
    setSnapshot((current) => {
      if (
        current === null ||
        current.instanceId !== next.instanceId ||
        current.blueprint.blobHash !== next.blueprint.blobHash
      ) {
        replayedIdentity.current = "";
        return next;
      }
      if (
        next.events.some(({ sequence }) => sequence <= current.nextSequence)
      ) {
        throw new Error("Lifecycle tail overlaps replayed history");
      }
      const expected = current.nextSequence + 1;
      if (
        next.events[0] !== undefined &&
        next.events[0].sequence !== expected
      ) {
        throw new Error("Lifecycle tail is not contiguous");
      }
      return {
        ...next,
        events: [...current.events, ...next.events],
      };
    });
  }, []);

  useEffect(() => {
    const port: LifecycleViewerPort = {
      append,
      clear: () => {
        replayedIdentity.current = "";
        setSnapshot(null);
      },
      replace,
    };
    window.heddleLifecycleViewer = port;
    return () => {
      if (window.heddleLifecycleViewer === port) {
        delete window.heddleLifecycleViewer;
      }
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
    applyCurrentStages(editor, snapshot);
    editor.zoomToFit({ animation: { duration: 0 }, inset: 56 });
  }, [editor, snapshot]);

  const traversals = useMemo(
    () => (snapshot === null ? [] : traversalCounts(snapshot.events)),
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
          <Tldraw
            components={{
              ActionsMenu: null,
              ContextMenu: null,
              DebugMenu: null,
              HelpMenu: null,
              MainMenu: null,
              NavigationPanel: null,
              PageMenu: null,
              QuickActions: null,
              SharePanel: null,
              StylePanel: null,
              Toolbar: null,
              ZoomMenu: null,
            }}
            hideUi
            onMount={setEditor}
            shapeUtils={shapeUtils}
          />
        )}
      </div>
      <aside
        className="lifecycle-history"
        aria-labelledby="lifecycle-history-title"
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
