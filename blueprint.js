// Heddle task-lifecycle blueprint (declarative, serializable JSON).
export const blueprint = {
	id: 'task-lifecycle',
	nodes: [
		{ id: 'implement', uses: 'implementNode' },
		// joinStrategy 'any' is REQUIRED: review has two predecessors (implement,
		// remediate). The default 'all' join deadlocks on the cycle back-edge and
		// the run silently reports status 'completed' without ever reaching review.
		{ id: 'review', uses: 'wait', config: { joinStrategy: 'any' } },
		{ id: 'remediate', uses: 'remediateNode', config: { joinStrategy: 'any' } },
		{ id: 'merge', uses: 'mergeNode' },
		{ id: 'retrospective', uses: 'retrospectiveNode' },
		{ id: 'done', uses: 'doneNode' },
	],
	edges: [
		{ source: 'implement', target: 'review' },
		// NOTE: the documented pattern is `action: 'approve'` / `action: 'reject'`.
		// It is broken twice over in flowcraft 2.10.1 (see docs/spikes/flowcraft-gate.md):
		//   1. resume() drops resumeData.action before edge matching, so action
		//      edges never match (runtime.mjs:311).
		//   2. GraphTraverser.fromState() re-adds ALL targets of non-condition
		//      edges from completed predecessors to the frontier, so on resume
		//      every action-edge target executes regardless of the action.
		// Condition edges avoid both: they are skipped by fromState and are
		// evaluated against the resume output.
		{ source: 'review', target: 'merge', condition: 'result.output.approved' },
		{ source: 'review', target: 'remediate', condition: 'result.output.rejected' },
		{ source: 'remediate', target: 'review' }, // cycle: remediate loops back to review
		{ source: 'merge', target: 'retrospective' },
		{ source: 'retrospective', target: 'done' },
	],
}

// Node implementations, registered by `uses` name.
export const registry = {
	implementNode: async ({ context }) => {
		await context.set('implemented', true)
		log('implement: agent session produced a change set')
		return { output: { changeSet: 'cs-001' } }
	},
	// joinStrategy 'any' also required here: remediate is inside the cycle and
	// must be re-runnable after it is in the completed set (a second reject).
	remediateNode: async ({ context }) => {
		const n = ((await context.get('remediations')) || 0) + 1
		await context.set('remediations', n)
		log(`remediate: applying review feedback (round ${n})`)
		return { output: { round: n } }
	},
	mergeNode: async ({ context, input }) => {
		await context.set('merged', true)
		log(`merge: merging after approval by ${input?.reviewer ?? 'unknown'}`)
		return { output: 'merged' }
	},
	retrospectiveNode: async ({ context }) => {
		log('retrospective: capturing learnings')
		return { output: 'retro-notes' }
	},
	doneNode: async ({ context }) => {
		log('done: lifecycle complete')
		return { output: 'done' }
	},
	// gate 2: a node that sleeps long enough to kill -9 mid-execution
	slowNode: async ({ context }) => {
		log('slowNode: starting 10s of work (kill me now)')
		await new Promise((r) => setTimeout(r, 10000))
		await context.set('slowDone', true)
		return { output: 'slow-done' }
	},
}

function log(msg) {
	console.log(`[pid ${process.pid}] ${msg}`)
}
