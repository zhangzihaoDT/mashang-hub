import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {marketDiscussionContext} from '../worker/market-discussion.mjs';
const root=await mkdtemp(join(tmpdir(),'market-talk-'));try{
await mkdir(join(root,'observation'));await mkdir(join(root,'run_day'));
const html='<h1>市场方向</h1><table><tr><td>出版</td><td>100</td></tr></table><script>NEVER_SEND_SCRIPT</script>';
const file=join(root,'observation/report.html');await writeFile(file,html);
const result={ok:true,status:'CONFIRMED',data_complete:false,warnings:['price_basis_verified=false'],errors:[]};
const receipt={trade_date:'20261013',run_id:'batch-one',result};
await writeFile(join(root,'run_day/publication.json'),JSON.stringify(receipt));await writeFile(join(root,'run_day/final_check_20261013.json'),JSON.stringify(result));
const id='runtime_'+ 'a'.repeat(64),a={artifactId:id,file,extension:'.html',runId:'batch-one',targetDate:'20261013',digest:createHash('sha256').update(html).digest('hex')};
const map=new Map([[id,a]]),task={marketArtifactId:id,prompt:'解释市场'};
const text=await marketDiscussionContext(task,map);assert.match(text,/出版/);assert.match(text,/price_basis_verified=false/);assert.match(text,/batch-one/);assert.ok(!text.includes('NEVER_SEND_SCRIPT'));assert.ok(!text.includes(root));
await assert.rejects(marketDiscussionContext({...task,marketArtifactId:'missing'},map),/UNAVAILABLE/);
await writeFile(file,html+'tampered');await assert.rejects(marketDiscussionContext(task,map),/CHANGED/);await writeFile(file,html);
await writeFile(join(root,'run_day/publication.json'),JSON.stringify({...receipt,run_id:'other'}));await assert.rejects(marketDiscussionContext(task,map),/INVALID/);
console.log('Market discussion: fixed batch, full quality, tamper rejection, unknown selection fails closed');
}finally{await rm(root,{recursive:true,force:true});}
