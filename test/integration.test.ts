import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/app.js';
import {createMemory} from '../src/memory.js';
import {createRobot} from '../src/robot.js';
import type {CognitionPort} from '../src/contracts.js';

const cognition:CognitionPort={
 statuses:()=>[{name:'test',configured:false,state:'simulation'}],
 decide:async()=>({notify:false,research:false,escalate:false,probability:0,provider:'rules',mode:'simulation'}),
 research:async(query)=>({query,sources:[],retrievedAt:new Date().toISOString(),mode:'simulation'}),
 reply:async(message)=>({text:'Respuesta de prueba: '+message,mode:'simulation',sources:[],decision:{notify:false,research:false,escalate:false,probability:0,provider:'rules',mode:'simulation'},model:'test'}),
 observe:async()=>{throw new Error('No hay cámara de prueba');}
};
test('HTTP: auth, observations, goal verification, context and restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'organima-integration-'));
 let offset=-5000;
 const memory=await createMemory(dir);
 const service=createApp({mode:'simulation',memory,cognition,robot:createRobot({mode:'simulation',now:()=>Date.now()+offset}),operatorToken:'integration-secret'});
 const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const post=(path:string,body:unknown,token='integration-secret')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Organima-Token':token},body:JSON.stringify(body)});
 try{
  assert.equal((await post('/api/demo/step',{step:'reset'},'wrong')).status,401);
  assert.equal((await post('/api/demo/step',{step:'reset'})).status,200);
  assert.equal(memory.snapshot().relations[0].object,'cup');
  assert.equal((await post('/api/demo/step',{step:'move'})).status,200);
  assert.equal(memory.snapshot().relations[0].object,'table');
  assert.equal((await post('/api/goals',{object:'red_ball',target:'paper'})).status,202);
  assert.equal((await post('/api/goals',{object:'red_ball',target:'paper'})).status,409);
  assert.equal(memory.snapshot().events.at(-1)?.type,'goal.rejected');
  assert.equal((await post('/api/demo/step',{step:'verify'})).status,409);
  await service.tick();offset=0;await service.tick();
  const verify=await post('/api/demo/step',{step:'verify'});assert.equal(verify.status,200);assert.equal((await verify.json()).robot.state,'verified');
  const chat=await post('/api/chat',{message:'¿Dónde está?'});assert.equal(chat.status,200);assert.equal(memory.context('voice').length,2);
  const location=await (await post('/api/chat',{message:'¿Dónde está la pelota roja?'})).json();assert.equal(location.model,'local-memory');assert.match(location.text,/la hoja/);assert.equal(location.sources.length,0);
  const state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.mode,'simulation');assert.equal(JSON.stringify(state).includes('integration-secret'),false);
  assert.equal((await post('/api/chat',{message:''})).status,400);
  const restored=await createMemory(dir);assert.equal(restored.snapshot().relations[0].object,'paper');
 }finally{service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('live API never exposes simulation controls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'organima-live-api-'));const service=createApp({mode:'live',memory:await createMemory(dir),cognition,robot:createRobot({mode:'live'})});
 const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
 try{const goal=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/goals`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({object:'red_ball',target:'paper'})});assert.equal(goal.status,409);assert.equal(service.state().graph.events.at(-1)?.type,'goal.rejected');const res=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/demo/step`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({step:'move'})});assert.equal(res.status,409);}
 finally{service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('a stop cancels a cloud movement decision still in flight',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'organima-stop-race-'));
 let resolveIntent!:(value:any)=>void;let started!:()=>void;
 const entered=new Promise<void>(r=>{started=r;});
 const master={plan:async()=>{started();return await new Promise<any>(r=>{resolveIntent=r;});}};
 const robot=createRobot({mode:'simulation'});
 const service=createApp({mode:'simulation',memory:await createMemory(dir),cognition,robot,master});
 const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  const pending=post('/api/chat',{message:'Mueve la pelota roja a la hoja'});await entered;
  for(const message of ['¡Alto!','detente ya','para ya','para el robot','stop ya','por favor detén el robot ahora'])assert.equal((await post('/api/chat',{message})).status,200,message);
  resolveIntent({action:'move',object:'red_ball',target:'paper',reason:'test'});
  assert.equal((await pending).status,409);assert.equal(robot.status(),null);
 }finally{service.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('voice route protects synthesis and returns audio bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'organima-voice-api-'));let calls=0;
 const service=createApp({mode:'simulation',memory:await createMemory(dir),cognition,robot:createRobot({mode:'simulation'}),operatorToken:'test',voice:{status:()=>({configured:true,state:'untested',provider:'elevenlabs',language:'es'}),synthesize:async()=>{calls++;return new Uint8Array([73,68,51]);}}});
 const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{
  assert.equal((await fetch(base+'/api/voice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'hola'})})).status,401);assert.equal(calls,0);
  const res=await fetch(base+'/api/voice',{method:'POST',headers:{'Content-Type':'application/json','X-Organima-Token':'test'},body:JSON.stringify({text:'hola'})});
  assert.equal(res.status,200);assert.match(res.headers.get('content-type')!,/audio/);assert.equal((await res.arrayBuffer()).byteLength,3);assert.equal(calls,1);
 }finally{service.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('journal quota rejects writes without changing the durable projection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'organima-quota-'));
 try{
  const memory=await createMemory(dir,1);
  await assert.rejects(()=>memory.append({id:'quota',type:'note',cellId:'test',occurredAt:new Date().toISOString(),mode:'simulation',payload:{text:'too large'}}),/capacity/);
  assert.equal(memory.snapshot().version,0);assert.equal((await createMemory(dir,1)).snapshot().version,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
