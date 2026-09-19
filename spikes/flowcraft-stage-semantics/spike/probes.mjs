// relationships: { references: SPIKE-REPORT }
import { FlowRuntime, BaseNode, SubflowNode, GraphTraverser, WorkflowState } from 'flowcraft';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const log = (label, data) => console.log(label, JSON.stringify(data));
const view = r => ({status:r.status, context:r.context, errors:r.errors?.map(e=>e.message)});
const save = (name,r) => writeFileSync(new URL(`./${name}.json`, import.meta.url),r.serializedContext);
class Pause extends BaseNode { async exec(_, c) { await c.dependencies.workflowState.markAsAwaiting(this.nodeId,{threadId:'abc'}); return {output:undefined}; } }
const calls=[];
const registry={pause:Pause, SubflowNode, record:async c=>{calls.push(c.params.label); return {output:c.input ?? c.params.label};}, mapped:async c=>{calls.push('after');return {output:await c.context.get('mapped') ?? null};}};
const make=(blueprints={})=>new FlowRuntime({registry,blueprints});
const n=(id,uses='record',extra={})=>({id,uses,params:{label:id},...extra});
const e=(source,target,extra={})=>({source,target,...extra});
const child={id:'child',nodes:[n('gate','pause'),n('childEnd')],edges:[e('gate','childEnd')]};
const parent=uses=>({id:'parent',nodes:[n('stage',uses,{params:{blueprintId:'child',outputs:{mapped:'childEnd'}}}),n('after','mapped')],edges:[e('stage','after')]});
for(const uses of ['subflow','SubflowNode']) {
 calls.length=0; const bp=parent(uses); const paused=await make({child}).run(bp);save(`parent-${uses}`,paused);log(`subflow ${uses} pause`,view(paused));
 for(const id of ['gate','stage']) {calls.length=0;try {const r=await make({child}).resume(structuredClone(bp),paused.serializedContext,{action:'handoff',output:{value:7}},id);log(`subflow ${uses} resume ${id}`,{...view(r),calls:[...calls]});}catch(err){log(`subflow ${uses} resume ${id}`,{error:err.message,calls:[...calls]});}}
 if(uses==='subflow') {calls.length=0;const r=await make().resume(child,JSON.parse(paused.serializedContext)['_subflowState.stage'],{action:'handoff',output:{value:7}},'gate');log('child standalone resume',{...view(r),calls:[...calls]});}
}
calls.length=0;const flat=await make().run(child);save('details',flat);log('details',JSON.parse(flat.serializedContext));const flatDone=await make().resume(child,flat.serializedContext,{action:'handoff',output:{value:7}},'gate');assert.equal(flatDone.status,'completed');log('flattened resume',{...view(flatDone),calls:[...calls]});
const actions=['handoff','escalate','timeout'];
for(const conditions of [false,true]) {
 const bp={id:'actions',nodes:[n('gate','wait'),...actions.map(a=>n(a))],edges:actions.map(a=>e('gate',a,conditions?{condition:`result.output.${a}`}:{action:a}))};
 calls.length=0; const paused=await make().run(bp);const r=await make().resume(bp,paused.serializedContext,{action:'escalate',output:{handoff:false,escalate:true,timeout:false}},'gate');
 log(conditions?'condition edges':'action edges',{...view(r),calls:[...calls]});if(conditions)assert.deepEqual(calls,['escalate']);
 if(!conditions){ const state=new WorkflowState(JSON.parse(paused.serializedContext));await state.addCompletedNode('gate',{});log('fromState action successors',GraphTraverser.fromState(bp,state).getReadyNodes().map(n=>n.nodeId)); }
}
// A default successor makes resume reach fromState, exposing its action-edge defect.
{
 const bp={id:'actions-default',nodes:[n('gate','wait'),...actions.map(a=>n(a)),n('fallback')],edges:[...actions.map(a=>e('gate',a,{action:a})),e('gate','fallback')]};
 calls.length=0;const p=await make().run(bp);const r=await make().resume(bp,p.serializedContext,{action:'escalate',output:{}},'gate');log('action edges with default',{status:r.status,calls:[...calls]});
}
