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
  assert.equal((await post('/api/demo/step',{step:'verify'})).status,409);
  await service.tick();offset=0;await service.tick();
  const verify=await post('/api/demo/step',{step:'verify'});assert.equal(verify.status,200);assert.equal((await verify.json()).robot.state,'verified');
  const chat=await post('/api/chat',{message:'¿Dónde está?'});assert.equal(chat.status,200);assert.equal(memory.context('voice').length,2);
  const state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.mode,'simulation');assert.equal(JSON.stringify(state).includes('integration-secret'),false);
  assert.equal((await post('/api/chat',{message:''})).status,400);
  const restored=await createMemory(dir);assert.equal(restored.snapshot().relations[0].object,'paper');
 }finally{service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('live API never exposes simulation controls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'organima-live-api-'));const service=createApp({mode:'live',memory:await createMemory(dir),cognition,robot:createRobot({mode:'live'})});
 const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
 try{const res=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/demo/step`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({step:'move'})});assert.equal(res.status,409);}
 finally{service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
