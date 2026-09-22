import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CognitionPort, MemoryPort, Mode, OrganimaEvent, RobotPort } from './contracts.js';

export interface AppOptions { mode: Mode; memory: MemoryPort; cognition: CognitionPort; robot: RobotPort; operatorToken?: string; publicDirectory?: string; knowledge?: string; }
export function createApp(options: AppOptions) {
 const {mode,memory,cognition,robot}=options;
 const app=express(); app.disable('x-powered-by');
 const clients=new Set<express.Response>();
 const state=()=>({mode,graph:memory.snapshot(),cells:[{id:'organism',parentId:null,name:'Organima',capabilities:['remember','research','converse','observe'],status:'ready',mode},robot.describe()],providers:cognition.statuses(),robot:robot.status()});
 const publish=()=>{const data=`event: state\ndata: ${JSON.stringify(state())}\n\n`;for(const res of clients)res.write(data);};
 const event=async(type:string,cellId:string,payload:Record<string,unknown>)=>{const e:OrganimaEvent={id:randomUUID(),type,cellId,occurredAt:new Date().toISOString(),mode,payload};await memory.append(e);publish();return e;};
 app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');next();});
 app.use(express.json({limit:'3mb'}));
 app.use('/api',(req,res,next)=>{
  if(req.method==='GET'){next();return;}
  if(options.operatorToken){const supplied=Buffer.from(req.get('X-Organima-Token')??'');const expected=Buffer.from(options.operatorToken);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.status(401).json({error:'Se requiere el acceso de operador.'});return;}}
  if(!req.is('application/json')){res.status(415).json({error:'Usa application/json.'});return;}
  next();
 });
 app.get('/api/health',(_req,res)=>res.json({ok:true,mode,hardwareConnected:false}));
 app.get('/api/state',(_req,res)=>res.json(state()));
 app.get('/api/memory', (req,res)=>res.json(memory.query(z.string().max(200).parse(req.query.q??''))));
 app.get('/api/events',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Connection','keep-alive');res.flushHeaders();clients.add(res);res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(heartbeat);clients.delete(res);});});
 let conversationBusy=false;
 app.post('/api/chat',async(req,res)=>{
  const {message}=z.object({message:z.string().trim().min(1).max(4000)}).strict().parse(req.body);
  if(conversationBusy){res.status(409).json({error:'Ya estoy atendiendo una pregunta. Puedes detener el robot en cualquier momento.'});return;}
  conversationBusy=true;
  try{
   const history=memory.context('voice');
   const knowledge:OrganimaEvent[] = options.knowledge ? [{id:'stable-knowledge',cellId:'knowledge',type:'canonical_knowledge',occurredAt:new Date().toISOString(),mode,payload:{text:options.knowledge}}] : [];
   const reply=await cognition.reply(message,memory.snapshot(),[...knowledge,...history]);
   const userEvent=await event('conversation.user','voice',{text:message});
   const replyEvent=await event('conversation.reply','voice',{text:reply.text,sources:reply.sources,model:reply.model,decision:reply.decision});
   memory.setContext('voice',[...history,userEvent,replyEvent]);
   if(reply.sources.length)await event('research.completed','research',{query:message,sources:reply.sources});
   publish();res.json(reply);
  }finally{conversationBusy=false;}
 });
 app.post('/api/research',async(req,res)=>{const {query}=z.object({query:z.string().trim().min(1).max(1000)}).strict().parse(req.body);const result=await cognition.research(query);await event('research.completed','research',{...result});res.json(result);});
 app.post('/api/observe',async(req,res)=>{const {imageDataUrl}=z.object({imageDataUrl:z.string().max(2800000)}).strict().parse(req.body);const relations=await cognition.observe(imageDataUrl);await event('observation','vision_global',{relations});const before=robot.status()?.state;robot.verify(relations,'vision_global');if(robot.status()?.state!==before)await event('goal.verified','organism',{status:robot.status()});const decision=await cognition.decide(JSON.stringify({relations,state:memory.snapshot(),purpose:'Notify meaningful changes, never claim unknown presence'}));await event('attention.decision','jev',{decision});res.json({relations,decision,robot:robot.status()});});
 app.post('/api/goals',async(req,res)=>{const {object,target}=z.object({object:z.literal('red_ball'),target:z.literal('paper')}).strict().parse(req.body);const result=robot.submit({id:randomUUID(),cellId:'robot',object,target,relation:'ON',deadline:new Date(Date.now()+60000).toISOString(),mode});await event('goal.accepted','robot',{status:result});res.status(202).json(result);});
 app.post('/api/stop',async(_req,res)=>{const result=robot.cancel('Parada solicitada por operador');await event('goal.cancelled','robot',{status:result});res.json({robot:result});});
 app.post('/api/demo/step',async(req,res)=>{
  if(mode!=='simulation'){res.status(409).json({error:'Escenarios disponibles únicamente en simulación.'});return;}
  const {step}=z.object({step:z.enum(['reset','move','verify'])}).strict().parse(req.body);
  if(step==='reset')robot.cancel('Reinicio del escenario simulado');
  const relation={subject:'red_ball',predicate:'ON',object:step==='reset'?'cup':step==='move'?'table':'paper',source:'vision_global',confidence:1,observedAt:new Date().toISOString()};
  if(step==='verify'&&robot.status()?.state!=='awaiting_verification'){res.status(409).json({error:'Espera a que el robot solicite verificación.'});return;}
  await event('observation','vision_global',{relations:[relation],simulated:true});
  if(step==='verify'){robot.verify([relation],'vision_global');await event('goal.verified','organism',{status:robot.status(),simulated:true});}
  res.json(state());
 });
 if(options.publicDirectory)app.use(express.static(options.publicDirectory));
 app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof z.ZodError){res.status(400).json({error:'La solicitud no cumple el contrato.',fields:err.issues.map(i=>i.path.join('.'))});return;}
  if(err instanceof SyntaxError){res.status(400).json({error:'JSON inválido.'});return;}
  res.status(503).json({error:'La operación no pudo completarse. Revisa disponibilidad y configuración del proveedor.',detail:err instanceof Error?err.message.replace(/Bearer\s+\S+|(?:sk-|tvly-)[A-Za-z0-9_-]+/g,'[redacted]').slice(0,250):'Error interno'});
 });
 let ticking=false;
 const tick=async()=>{if(ticking)return;ticking=true;try{const before=robot.status()?.state;const result=robot.tick();if(result?.state!==before)await event('goal.progress','robot',{status:result});}finally{ticking=false;}};
 return {app,state,tick,close:()=>{for(const res of clients)res.end();clients.clear();}};
}
