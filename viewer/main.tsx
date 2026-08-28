// Gate 3 harness: prove the tldraw execution view can be driven by an
// EXTERNAL runtime. No FlowRuntime exists in this page. We render the
// blueprint with the vendored @flowcraft/tldraw primitives, then replay the
// event log recorded by the service process (spike.js -> sqlite -> events.json)
// into an EventBus that useExecutionBridge subscribes to.
import { StrictMode, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Tldraw, defaultShapeUtils } from 'tldraw'
import type { Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { FlowcraftNodeUtil } from './vendor/flowcraft-tldraw/shapes/FlowcraftNodeUtil'
import { EventBus } from './vendor/flowcraft-tldraw/sync/EventBus'
import { FlowcraftSync } from './vendor/flowcraft-tldraw/sync/FlowcraftSync'
import { useExecutionBridge } from './vendor/flowcraft-tldraw/runtime/ExecutionBridge'
import { blueprint } from '../blueprint.js'
import recordedEvents from './events.json'

const positions: Record<string, { x: number; y: number }> = {
	implement: { x: 0, y: 200 },
	review: { x: 320, y: 200 },
	remediate: { x: 320, y: 0 },
	merge: { x: 640, y: 200 },
	retrospective: { x: 960, y: 200 },
	done: { x: 1280, y: 200 },
}

function App() {
	const [editor, setEditor] = useState<Editor | null>(null)
	const busRef = useRef(new EventBus())
	const [replayed, setReplayed] = useState(0)

	// The bridge subscribes the canvas to the bus. Nothing else connects them.
	useExecutionBridge(editor, busRef.current)

	const handleMount = useCallback((ed: Editor) => {
		new FlowcraftSync(ed).applyBlueprint(blueprint as any, positions)
		ed.zoomToFit()
		setEditor(ed)
	}, [])

	const replay = useCallback(async () => {
		let n = 0
		for (const event of recordedEvents as any[]) {
			busRef.current.emit(event)
			n += 1
			setReplayed(n)
			await new Promise((r) => setTimeout(r, 150))
		}
	}, [])

	return (
		<div style={{ position: 'relative', width: '100%', height: '100%' }}>
			<Tldraw shapeUtils={[FlowcraftNodeUtil, ...defaultShapeUtils]} onMount={handleMount} />
			<div style={{ position: 'absolute', top: 8, left: 8, zIndex: 1000, background: 'white', padding: 8, borderRadius: 6, boxShadow: '0 1px 4px rgba(0,0,0,.3)' }}>
				<button type="button" onClick={replay} data-testid="replay">
					Replay external event log ({(recordedEvents as any[]).length} events)
				</button>
				<span style={{ marginLeft: 8 }} data-testid="progress">{replayed} replayed</span>
			</div>
		</div>
	)
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
