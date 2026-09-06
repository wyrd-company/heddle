// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

import type { Editor } from "tldraw";

import { FLOWCRAFT_NODE } from "../../spikes/flowcraft-gate/viewer/vendor/flowcraft-tldraw/shapes/types";
import { MIN_READABLE_NODE_SCALE } from "./lifecycle-canvas-layout.js";

export const READ_ONLY_ZOOM_STEPS = [MIN_READABLE_NODE_SCALE, 1, 1.5, 2, 4, 8];

interface Bounds {
  h: number;
  w: number;
  x: number;
  y: number;
}

const commonBounds = (bounds: readonly Bounds[]): Bounds | undefined => {
  if (bounds.length === 0) return undefined;
  const left = Math.min(...bounds.map(({ x }) => x));
  const top = Math.min(...bounds.map(({ y }) => y));
  const right = Math.max(...bounds.map(({ w, x }) => x + w));
  const bottom = Math.max(...bounds.map(({ h, y }) => y + h));
  return { h: bottom - top, w: right - left, x: left, y: top };
};

const lifecycleNodeBounds = (editor: Editor, ids?: ReadonlySet<string>) =>
  editor
    .getCurrentPageShapes()
    .filter(
      (shape) =>
        shape.type === FLOWCRAFT_NODE &&
        (ids === undefined || ids.has(shape.id.slice("shape:".length))),
    )
    .map((shape) => editor.getShapePageBounds(shape))
    .filter(
      (bounds): bounds is NonNullable<typeof bounds> => bounds !== undefined,
    );

const centerAtReadableScale = (
  editor: Editor,
  bounds: Bounds,
  screenTargetY?: number,
) => {
  const viewport = editor.getViewportScreenBounds();
  const zoom = Math.max(1, editor.getZoomLevel());
  editor.setCamera(
    {
      x: viewport.width / 2 / zoom - (bounds.x + bounds.w / 2),
      y:
        (screenTargetY ?? viewport.height * 0.32) / zoom -
        (bounds.y + bounds.h / 2),
      z: zoom,
    },
    { animation: { duration: 0 } },
  );
};

export const setReadableLifecycleCamera = (editor: Editor): void => {
  editor.setCameraOptions({ zoomSteps: READ_ONLY_ZOOM_STEPS });
};

export const fitLifecycleCanvas = (editor: Editor): void => {
  editor.zoomToFit({ animation: { duration: 0 } });
};

export const focusCurrentLifecycleStage = (
  editor: Editor,
  currentStageIds: readonly string[],
  screenTargetY?: number,
): void => {
  const current = commonBounds(
    lifecycleNodeBounds(editor, new Set(currentStageIds)),
  );
  if (current !== undefined) {
    centerAtReadableScale(editor, current, screenTargetY);
  }
};

export const frameReadableLifecycleCanvas = (
  editor: Editor,
  currentStageIds: readonly string[],
  visibleCanvas?: { height: number; top: number },
): void => {
  fitLifecycleCanvas(editor);
  const graph = commonBounds(lifecycleNodeBounds(editor));
  if (graph === undefined) return;
  const viewport = editor.getViewportPageBounds();
  const fits =
    graph.x >= viewport.x &&
    graph.y >= viewport.y &&
    graph.x + graph.w <= viewport.x + viewport.w &&
    graph.y + graph.h <= viewport.y + viewport.h;
  const canvasIsClipped =
    visibleCanvas !== undefined &&
    visibleCanvas.height < editor.getViewportScreenBounds().height * 0.75;
  if (fits && !canvasIsClipped) return;
  const screenTargetY =
    visibleCanvas === undefined
      ? undefined
      : visibleCanvas.top + visibleCanvas.height * 0.5;
  focusCurrentLifecycleStage(editor, currentStageIds, screenTargetY);
};
