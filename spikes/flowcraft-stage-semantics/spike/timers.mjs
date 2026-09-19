// relationships: { references: SPIKE-REPORT }
import {FlowRuntime} from 'flowcraft';
import {readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const log=(label,data)=>console.log(label,JSON.stringify(data));
const calls=[];
const bp={id:'race',nodes:[{id:'start',uses:'start'},{id:'gate',uses:'wait'},{id:'timer',uses:'sleep',params:{duration:150}},{id:'join',uses:'join',config:{joinStrategy:'any'}}],edges:[{source:'start',target:'gate'},{source:'start',target:'timer'},{source:'gate',target:'join'},{source:'timer',target:'join'}]};
const make=()=>new FlowRuntime({blueprints:{race:bp},registry:{start:async()=>({output:'seed'}),join:async c=>{calls.push(c.input ?? null);return {output:c.input ?? null};}}});
const view=r=>r?{status:r.status,awaiting:r.context._awaitingNodeIds??[],details:r.context._awaitingDetails??{},join:r.context['_outputs.join']??null}:null;
const file=new URL('./timer-state.json',import.meta.url);
if(process.argv[2]==='save') {const rt=make();const r=await rt.run(bp);writeFileSync(file,r.serializedContext);log('producer exit without scheduler',{...view(r),registered:rt.scheduler.getActiveWorkflows().length});}
else if(process.argv[2]==='restore') {
 const serialized=readFileSync(file,'utf8');await delay(200);const rt=make();rt.startScheduler();try{await delay(1100);log('fresh process scheduler',{registered:rt.scheduler.getActiveWorkflows().length,calls:[...calls]});
 const r=await rt.resume(bp,serialized,{output:'timeout'},'timer');log('manual overdue resume',{...view(r),calls:[...calls]});}finally{rt.stopScheduler();}
 const rt2=make();const original=JSON.parse(serialized);rt2.scheduler.registerAwaitingWorkflow(original._executionId,bp.id,serialized,'timer',original._awaitingDetails.timer.wakeUpAt);rt2.startScheduler();try{await delay(1100);log('explicit re-registration',{...view(rt2.scheduler.getResumeResult(original._executionId)),registered:rt2.scheduler.getActiveWorkflows().length});}finally{rt2.stopScheduler();}
} else {
 for(const first of ['wait','sleep']) {
 calls.length=0;const rt=make();rt.startScheduler();try {
 const paused=await rt.run(bp);const id=paused.context._executionId;log(`${first} initial`,{...view(paused),registered:rt.scheduler.getActiveWorkflows().length});
 if(first==='wait'){const r=await rt.resume(bp,paused.serializedContext,{action:'handoff',output:'human'},'gate');log('wait resumed',{...view(r),calls:[...calls],registered:rt.scheduler.getActiveWorkflows().length});}
 await delay(1150);const scheduled=rt.scheduler.getResumeResult(id);log(`${first} after timer`,{...view(scheduled),calls:[...calls],registered:rt.scheduler.getActiveWorkflows().length});
 if(first==='sleep'&&scheduled){const r=await rt.resume(bp,scheduled.serializedContext,{action:'handoff',output:'late-human'},'gate');log('sleep then late wait',{...view(r),calls:[...calls]});}
 await delay(1000);log(`${first} next scheduler tick`,{...view(rt.scheduler.getResumeResult(id)),calls:[...calls],registered:rt.scheduler.getActiveWorkflows().length});
 } finally{rt.stopScheduler();}
 }
}
