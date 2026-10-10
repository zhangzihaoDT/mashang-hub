import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionJournal } from '../worker/execution-journal.mjs';
const directory=mkdtempSync(join(tmpdir(),'hub-journal-'));
try {
 const path=join(directory,'journal.json');let journal=new ExecutionJournal(path);
 const request={taskId:'task1',attemptId:'attempt1',dispatchId:'dispatch1'};
 assert.ok(journal.begin(request));assert.equal(journal.begin(request),false);
 assert.equal(journal.reconcile([request],()=>true)[0].state,'RUNNING');
 journal=new ExecutionJournal(path);
 assert.equal(journal.reconcile([request],()=>false)[0].state,'INTERRUPTED','persisted RUNNING does not prove liveness');
 assert.equal(journal.reconcile([{...request,attemptId:'wrong'}],()=>true)[0].state,'UNKNOWN');
 journal.record({type:'task.running',taskId:'task1',externalEffectPossible:true});
 assert.equal(journal.reconcile([request],()=>false)[0].state,'UNCERTAIN');
 journal.record({type:'agent.message.completed',taskId:'task1',text:'result'});
 journal.record({type:'task.completed',taskId:'task1'});
 journal=new ExecutionJournal(path);
 const result=journal.reconcile([request],()=>false)[0];assert.equal(result.state,'RESULT');assert.equal(result.events.length,2);assert.equal(result.events[0].attemptId,'attempt1');
 writeFileSync(path,'broken');assert.throws(()=>new ExecutionJournal(path));
 console.log('Durable Worker evidence, duplicate dispatch refusal, restart and result outbox passed');
}finally{rmSync(directory,{recursive:true,force:true});}
