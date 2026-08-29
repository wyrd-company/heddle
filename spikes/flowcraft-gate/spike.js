// Gate 1/2 driver: each invocation is a fresh process. State lives on disk only.
//   node spike.js start [instance]
//   node spike.js resume <instance> <action> [reviewer]
//   node spike.js status <instance>
//   node spike.js history <instance>
import fs from 'node:fs'
import path from 'node:path'
import { FlowRuntime, PersistentEventBusAdapter, analyzeBlueprint } from 'flowcraft'
import { SqliteHistoryAdapter } from '@flowcraft/sqlite-history'
import { blueprint, registry } from './blueprint.js'

const DATA = path.join(import.meta.dirname, 'data')
fs.mkdirSync(DATA, { recursive: true })
const DB = path.join(DATA, 'history.sqlite')

const store = new SqliteHistoryAdapter({ databasePath: DB })

// UPSTREAM BUG (flowcraft 2.10.1): FlowRuntime.resume() builds
// `nodeResult = { output: nodeOutput }`, dropping `resumeData.action`
// (dist/runtime/runtime.mjs:311). Action-labeled edges out of a wait node
// therefore NEVER match on resume, despite the documented
// "Conditional Branching with Actions" pattern. Shim: carry the action in
// the resume output as `__action` and re-inject it before edge matching.
class HeddleRuntime extends FlowRuntime {
	async determineNextNodes(blueprint, nodeId, result, context, executionId) {
		if (result && !result.action && result.output?.__action) {
			result = { ...result, action: result.output.__action }
		}
		return super.determineNextNodes(blueprint, nodeId, result, context, executionId)
	}
}

const runtime = new HeddleRuntime({
	registry,
	eventBus: new PersistentEventBusAdapter(store),
})

const stateFile = (id) => path.join(DATA, `${id}.json`)
const load = (id) => JSON.parse(fs.readFileSync(stateFile(id), 'utf8'))
const save = (id, s) => fs.writeFileSync(stateFile(id), JSON.stringify(s, null, 2))

function report(id, result) {
	const record = {
		instance: id,
		status: result.status,
		executionIds: [...(load2(id)?.executionIds ?? []), extractExecutionId(result)],
		serializedContext: result.serializedContext ?? null,
		context: result.context ?? null,
		errors: result.errors ?? null,
	}
	save(id, record)
	console.log(`[pid ${process.pid}] instance=${id} status=${result.status}`)
	if (result.status === 'awaiting') {
		const ctx = JSON.parse(result.serializedContext)
		const awaiting = Object.keys(ctx).filter((k) => k.startsWith('_awaiting'))
		console.log(`[pid ${process.pid}] awaiting keys: ${awaiting.join(', ')}`)
	}
	if (result.errors) console.error(result.errors)
}
function load2(id) {
	try {
		return load(id)
	} catch {
		return null
	}
}
function extractExecutionId(result) {
	try {
		const ctx =
			result.serializedContext ? JSON.parse(result.serializedContext) : (result.context ?? {})
		return ctx._executionId ?? result.context?._executionId ?? null
	} catch {
		return null
	}
}

const [, , cmd, id = 'inst-1', action, reviewer = 'reviewer-1'] = process.argv

if (cmd === 'analyze') {
	console.log(JSON.stringify(analyzeBlueprint(blueprint), null, 2))
} else if (cmd === 'start') {
	const result = await runtime.run(blueprint, { taskId: id })
	report(id, result)
} else if (cmd === 'resume') {
	if (!action) throw new Error('resume requires an action')
	const saved = load(id)
	const result = await runtime.resume(
		blueprint,
		saved.serializedContext,
		{
			output: {
				reviewer,
				decision: action,
				approved: action === 'approve',
				rejected: action === 'reject',
			},
			action,
		},
		'review',
	)
	report(id, result)
} else if (cmd === 'resume-slow') {
	// Gate 2: same as `resume approve`, but merge is swapped for a node that
	// sleeps 10s so the process can be kill -9'd mid-node-execution.
	const saved = load(id)
	console.log(`[pid ${process.pid}] resuming with slow merge; kill -9 me now`)
	const result = await runtime.resume(
		blueprint,
		saved.serializedContext,
		{ output: { reviewer, decision: 'approve', approved: true, rejected: false }, action: 'approve' },
		'review',
		{ functionRegistry: new Map([['mergeNode', registry.slowNode]]) },
	)
	report(id, result)
} else if (cmd === 'replay') {
	// Gate 2: reconstruct state purely from the sqlite event history.
	const saved = load(id)
	const execId = saved.executionIds.filter(Boolean).at(-1)
	const events = await store.retrieve(execId)
	const result = await runtime.replay(blueprint, events, execId)
	console.log(JSON.stringify({ replayedFrom: execId, status: result.status, context: result.context }, null, 2))
} else if (cmd === 'export-events') {
	// Gate 3: dump the full sqlite event log for an instance to JSON so the
	// viewer harness (an entirely separate frontend process) can replay it.
	const saved = load(id)
	const all = []
	for (const execId of saved.executionIds.filter(Boolean)) {
		all.push(...(await store.retrieve(execId)))
	}
	const out = path.join(import.meta.dirname, 'viewer', 'events.json')
	fs.writeFileSync(out, JSON.stringify(all, null, 1))
	console.log(`wrote ${all.length} events to ${out}`)
} else if (cmd === 'status') {
	const saved = load(id)
	console.log(JSON.stringify({ status: saved.status, context: saved.context }, null, 2))
} else if (cmd === 'history') {
	const saved = load(id)
	for (const execId of saved.executionIds.filter(Boolean)) {
		const events = await store.retrieve(execId)
		console.log(`# execution ${execId}: ${events.length} events`)
		for (const e of events) {
			console.log(
				`  ${e.type} ${e.payload?.nodeId ?? ''} ${e.payload?.status ?? ''}`.trimEnd(),
			)
		}
	}
} else {
	console.error('usage: node spike.js <analyze|start|resume|status|history> ...')
	process.exit(1)
}
