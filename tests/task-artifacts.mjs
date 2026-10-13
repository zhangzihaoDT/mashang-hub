import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolArtifacts } from '../worker/task-artifacts.mjs';
const root=await mkdtemp(join(tmpdir(),'partial-files-'));
try{
 await mkdir(join(root,'outputs'));await mkdir(join(root,'dataset'));
 await writeFile(join(root,'outputs/current.html'),'<html>current</html>');await writeFile(join(root,'outputs/old.html'),'old');await writeFile(join(root,'dataset/raw.csv'),'private');
 const startedAt=Date.now()-1000;await utimes(join(root,'outputs/old.html'),new Date(startedAt-1000),new Date(startedAt-1000));
 const entry={startedAt,userMessageId:'user'},workspace={root,outputRoots:['outputs']};
 const tool=(path,status='completed',parentID='user')=>({info:{role:'assistant',parentID},parts:[{type:'tool',tool:'write',state:{status,input:{filePath:path}}}]});
 const files=await toolArtifacts([tool('outputs/current.html'),tool('outputs/current.html'),tool('outputs/old.html'),tool('dataset/raw.csv'),tool('outputs/current.html','running'),tool('outputs/current.html','completed','old-user')],entry,workspace);
 assert.deepEqual(files.map(a=>a.name),['current.html']);
 assert.equal((await toolArtifacts([tool('outputs/current.html','error')],entry,workspace)).length,0);
 assert.equal((await toolArtifacts([tool('outputs/current.html')],{...entry,finishedAt:startedAt+1},workspace)).length,0,'files overwritten after terminal state cannot be attributed to old task');
 console.log('Partial artifacts require successful current-turn tools, fresh files and allowed output roots');
}finally{await rm(root,{recursive:true,force:true});}
