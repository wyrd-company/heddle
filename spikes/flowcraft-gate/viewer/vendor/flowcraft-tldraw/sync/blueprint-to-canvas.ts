import type { Editor, TLCreateShapePartial, TLShapeId } from 'tldraw'
import { createShapeId } from 'tldraw'
import type { WorkflowBlueprint } from 'flowcraft'
import { FLOWCRAFT_NODE } from '../shapes/types'
import type { FlowcraftNodeShape } from '../shapes/types'

export interface BlueprintToCanvasOptions {
	positions?: Record<string, { x: number; y: number }>
}

export function blueprintToCanvas(
	editor: Editor,
	blueprint: WorkflowBlueprint,
	options: BlueprintToCanvasOptions = {},
): void {
	const existingGraphIds = editor
		.getCurrentPageShapes()
		.filter((shape) => shape.type === FLOWCRAFT_NODE || shape.type === 'arrow')
		.map(({ id }) => id)
	if (existingGraphIds.length > 0) editor.deleteShapes(existingGraphIds)

	const GAP_X = 300
	const GAP_Y = 150
	const COLS = 3

	const newNodeIds = new Set<TLShapeId>()
	const nodePartials: TLCreateShapePartial<FlowcraftNodeShape>[] = []

	for (let i = 0; i < blueprint.nodes.length; i++) {
		const nodeDef = blueprint.nodes[i]
		const shapeId = createShapeId(nodeDef.id)
		newNodeIds.add(shapeId)

		const explicitPos = options.positions?.[nodeDef.id]
		const pos = explicitPos ?? {
			x: (i % COLS) * GAP_X,
			y: Math.floor(i / COLS) * GAP_Y,
		}

		nodePartials.push({
			id: shapeId,
			type: FLOWCRAFT_NODE,
			x: pos.x,
			y: pos.y,
			props: {
				nodeDef,
				status: 'idle',
				w: 220,
				h: 80,
			},
		})
	}

	const arrowPartials: TLCreateShapePartial[] = []

	for (const edge of blueprint.edges) {
		const sourceShapeId = createShapeId(edge.source)
		const targetShapeId = createShapeId(edge.target)

		if (!newNodeIds.has(sourceShapeId) || !newNodeIds.has(targetShapeId)) continue

		const arrowId = createShapeId(`arrow-${edge.source}-${edge.target}`)
		const edgeDef = { ...edge } as Record<string, unknown>
		delete edgeDef.source
		delete edgeDef.target

		arrowPartials.push({
			id: arrowId,
			type: 'arrow',
			props: {
				start: { x: 0, y: 0 },
				end: { x: 2, y: 0 },
			},
			meta: { edgeDef },
		} as TLCreateShapePartial)
	}

	editor.createShapes(nodePartials)
	editor.createShapes(arrowPartials)

	// Create binding records for each arrow
	for (const edge of blueprint.edges) {
		const sourceShapeId = createShapeId(edge.source)
		const targetShapeId = createShapeId(edge.target)
		const arrowId = createShapeId(`arrow-${edge.source}-${edge.target}`)

		if (!newNodeIds.has(sourceShapeId) || !newNodeIds.has(targetShapeId)) continue

		editor.createBinding({
			fromId: arrowId,
			toId: sourceShapeId,
			type: 'arrow',
			props: { terminal: 'start' },
		})
		editor.createBinding({
			fromId: arrowId,
			toId: targetShapeId,
			type: 'arrow',
			props: { terminal: 'end' },
		})
	}

	editor.zoomToFit()
}
