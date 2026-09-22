/** Explicit opt-in: real Jev and Nebius APIs, synthetic state and disposable memory only. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createJevAttention} from '../src/attention.js';
import {createCognition} from '../src/cognition.js';
import {createMemory} from '../src/memory.js';
import {createApp} from '../src/app.js';
import {createRobot} from '../src/robot.js';
if(process.env.RUN_LIVE_JEV_CHECK!=='1')throw Error('Set RUN_LIVE_JEV_CHECK=1 for real provider calls.');
const report:{checkedAt:string;ok:boolean;[key:string]:unknown}={checkedAt:new Date().toISOString(),ok:false};
let directory:string|undefined;
let service:ReturnType<typeof createApp>|undefined;
let server:ReturnType<ReturnType<typeof createApp>['app']['listen']>|undefined;
try{
 const attention=createJevAttention();
 const started=performance.now();
 const decision=await attention.decide('Mensaje actual: Hola. El entorno no cambió. No hay riesgos, fallos ni objetivos activos.');
 assert.equal(decision.provider,'jev');
 report.evaluation={decision,elapsedMs:Math.round(performance.now()-started),status:attention.status()};
 directory=await mkdtemp(join(tmpdir(),'organima-jev-'));
 const memory=await createMemory(directory);
 const cognition=createCognition({mode:'live',env:{...process.env,ORGANIMA_ATTENTION_PROVIDER:'jev'}});
 const operatorToken=randomUUID();
 service=createApp({mode:'live',memory,cognition,robot:createRobot({mode:'live'}),operatorToken});
 server=service.app.listen(0,'127.0.0.1');
 await new Promise<void>((resolve,reject)=>{server!.once('listening',resolve);server!.once('error',reject);});
 const address=server.address();assert.ok(address&&typeof address==='object');
 const response=await fetch(`http://127.0.0.1:${address.port}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-Organima-Token':operatorToken},body:JSON.stringify({message:'Hola, responde con un saludo breve.'}),signal:AbortSignal.timeout(45000)});
 assert.equal(response.status,200,'Core chat should return 200');
 const reply=await response.json();assert.equal(reply.decision.provider,'jev');assert.match(reply.model,/^nvidia\//);
 const event=memory.snapshot().events.find(e=>e.type==='conversation.reply');assert.ok(event);
 assert.equal((event.payload.decision as {provider:string}).provider,'jev');
 report.core={httpStatus:response.status,model:reply.model,decision:reply.decision,persisted:true,providers:cognition.statuses()};
 report.ok=true;
}catch(e){
 const err=e as {name?:string;code?:string;statusCode?:number};
 report.error={name:err.name,code:err.code,status:err.statusCode};
 process.exitCode=1;
}finally{
 service?.close();
 if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
 if(directory)await rm(directory,{recursive:true,force:true});
 await mkdir('runtime',{recursive:true});
 await writeFile('runtime/jev-live-report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
