// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

import { useCallback, useEffect, useRef } from "react";
import {
  ArrowBindingUtil,
  ArrowShapeUtil,
  defaultTools,
  type Editor,
  TldrawEditor,
} from "tldraw";

import { FlowcraftNodeUtil } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/shapes/FlowcraftNodeUtil";
import {
  fitLifecycleCanvas,
  focusCurrentLifecycleStage,
  frameReadableLifecycleCanvas,
  setReadableLifecycleCamera,
} from "./lifecycle-canvas-navigation.js";

const bindingUtils = [ArrowBindingUtil];
const shapeUtils = [FlowcraftNodeUtil, ArrowShapeUtil];

interface LifecycleCanvasSurfaceProps {
  currentStageIds: readonly string[];
  editing: boolean;
  editor: Editor | null;
  frameIdentity: string;
  onMount(editor: Editor): void;
}

export function LifecycleCanvasSurface({
  currentStageIds,
  editing,
  editor,
  frameIdentity,
  onMount,
}: LifecycleCanvasSurfaceProps) {
  const shell = useRef<HTMLDivElement | null>(null);
  const currentStageIdsRef = useRef(currentStageIds);
  currentStageIdsRef.current = currentStageIds;

  useEffect(() => {
    if (editor === null || editing || shell.current === null) return;
    setReadableLifecycleCamera(editor);
    let firstFrame = 0;
    let secondFrame = 0;
    const frame = () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          if (shell.current === null) return;
          const rect = shell.current.getBoundingClientRect();
          const visibleTop = Math.max(rect.top, 0);
          const visibleBottom = Math.min(rect.bottom, window.innerHeight);
          frameReadableLifecycleCanvas(editor, currentStageIdsRef.current, {
            height: Math.max(0, visibleBottom - visibleTop),
            top: visibleTop - rect.top,
          });
        });
      });
    };
    const observer = new ResizeObserver(frame);
    observer.observe(shell.current);
    window.addEventListener("resize", frame);
    frame();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", frame);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [editing, editor, frameIdentity]);

  const fitGraph = useCallback(() => {
    if (editor !== null) fitLifecycleCanvas(editor);
  }, [editor]);

  const focusCurrent = useCallback(() => {
    if (editor !== null) {
      focusCurrentLifecycleStage(editor, currentStageIdsRef.current);
    }
  }, [editor]);

  return (
    <div
      ref={shell}
      className="lifecycle-canvas-shell"
      aria-label="Lifecycle graph"
      role="region"
    >
      {editing ? null : (
        <div
          aria-label="Lifecycle canvas controls"
          className="lifecycle-canvas-controls"
          role="toolbar"
        >
          <button
            aria-label="Zoom out"
            onClick={() => editor?.zoomOut()}
            title="Zoom out"
            type="button"
          >
            −
          </button>
          <button
            aria-label="Zoom in"
            onClick={() => editor?.zoomIn()}
            title="Zoom in"
            type="button"
          >
            +
          </button>
          <button onClick={fitGraph} title="Fit readable graph" type="button">
            FIT
          </button>
          <button
            onClick={focusCurrent}
            title="Focus current stage"
            type="button"
          >
            CURRENT
          </button>
        </div>
      )}
      <TldrawEditor
        bindingUtils={bindingUtils}
        initialState="select"
        onMount={onMount}
        shapeUtils={shapeUtils}
        tools={defaultTools}
      />
    </div>
  );
}
