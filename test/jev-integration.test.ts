import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCognition} from '../src/cognition.js';
import {normalizeChatReply,redactSecrets} from '../public/app.js';
const env={ORGANIMA_ATTENTION_PROVIDER:'jev',AI_GATEWAY_API_KEY:'vck_fake-test-key',NEBIUS_API_KEY:'test-nebius',NEBIUS_CHAT_MODEL:'nvidia/chat',NEBIUS_REASONING_MODEL:'nvidia/reason',TAVILY_API_KEY:'test-tavily'};
const snapshot={version:0,relations:[],events:[]};
function fixture(p={notify:0.1,research:0.1,escalate:0.1}){
 const calls:{url:string,body:any}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);const body=JSON.parse(String(init?.body));calls.push({url,body});
  if(url.includes('/evaluation-model'))return Response.json({answers:Object.fromEntries(Object.entries(p).map(([k,v])=>[k,{type:'boolean',probability:v}]))});
  if(url==='https://api.tavily.com/search')return Response.json({results:[]});
  if(url.endsWith('/chat/completions'))return Response.json({choices:[{message:{content:'Respuesta NVIDIA'},finish_reason:'stop'}]});
  throw Error('Unexpected endpoint');
 };return {calls,fetcher};
}
test('Jev decide independently from NVIDIA; reply uses NVIDIA only for conversation',async()=>{
 const {fetcher,calls}=fixture();const c=createCognition({mode:'live',env,fetcher});
 const d=await c.decide('Todo sin cambios');assert.equal(d.provider,'jev');assert.equal(calls.length,1);
 assert.equal(c.statuses().find(x=>x.model==='typesafe-ai/jev')?.state,'ready');
 const r=await c.reply('Hola',snapshot,[]);assert.equal(r.model,'nvidia/chat');assert.equal(r.decision.provider,'jev');
 assert.equal(calls.filter(x=>x.url.endsWith('/chat/completions')).length,1);
});
test('Jev escalation selects NVIDIA reasoning model, with no physical action',async()=>{
 const {fetcher,calls}=fixture({notify:.9,research:.1,escalate:.8});
 const r=await createCognition({mode:'live',env,fetcher}).reply('Hay evidencia contradictoria',snapshot,[]);
 assert.equal(r.model,'nvidia/reason');assert.equal(calls.at(-1)?.body.model,'nvidia/reason');assert.equal(r.decision.escalate,true);
});
test('Jev web request uses Tavily and explicit override retains original probability',async()=>{
 const {fetcher,calls}=fixture();const r=await createCognition({mode:'live',env,fetcher}).reply('Investiga noticias en internet',snapshot,[]);
 assert.equal(r.decision.research,true);assert.equal(r.decision.probabilities?.research,.1);assert.equal(r.decision.researchOverride,'explicit-web-request');
 assert.ok(calls.some(x=>x.url==='https://api.tavily.com/search'));
});
test('simulation never invokes Jev even when configured',async()=>{
 let count=0;const c=createCognition({mode:'simulation',env,fetcher:async()=>{count++;throw Error('Network forbidden');}});
 const r=await c.reply('Hola',snapshot,[]);assert.equal(r.decision.provider,'rules');assert.equal(count,0);
 assert.equal(c.statuses().find(x=>x.model==='typesafe-ai/jev')?.state,'simulation');
});
test('Jev missing key fails explicitly without NVIDIA fallback',async()=>{
 const {fetcher,calls}=fixture();const c=createCognition({mode:'live',env:{...env,AI_GATEWAY_API_KEY:''},fetcher});
 await assert.rejects(c.reply('Hola',snapshot,[]));assert.equal(calls.length,0);
 assert.equal(c.statuses().find(x=>x.model==='typesafe-ai/jev')?.state,'unconfigured');
});
test('provider error does not mark NVIDIA as ready or call fallback',async()=>{
 let count=0;const c=createCognition({mode:'live',env,fetcher:async()=>{count++;return Response.json({error:{message:'AI Gateway requires a valid credit card on file'}},{status:403});}});
 await assert.rejects(c.reply('Hola',snapshot,[]));assert.equal(count,1);
 assert.equal(c.statuses().find(x=>x.model==='typesafe-ai/jev')?.state,'error');
 assert.equal(c.statuses().find(x=>x.name==='nvidia-chat')?.state,'untested');
});
test('unknown attention provider rejected without exposing input',()=>{
 assert.throws(()=>createCognition({mode:'live',env:{...env,ORGANIMA_ATTENTION_PROVIDER:'other'}}),/debe ser jev o nvidia/);
});
test('browser preserves typed probabilities and redacts Vercel credentials',()=>{
 const d={notify:true,research:true,escalate:false,probability:.9,provider:'jev',mode:'live',probabilities:{notify:.9,research:.2,escalate:.1},threshold:.7,researchOverride:'explicit-web-request'};
 const r=normalizeChatReply({text:'Listo',mode:'live',decision:d});assert.deepEqual(r.decision.probabilities,d.probabilities);assert.equal(r.decision.researchOverride,d.researchOverride);
 assert.ok(!redactSecrets('Error vck_123456789abcdef').includes('123456789abcdef'));
});
