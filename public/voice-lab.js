/* Laboratorio A/B: mismo cerebro y transcriptor; sólo cambia TTS. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries(['provider','provider-note','start','terminate','interrupt','mic-state','notice','fallback-form','fallback-text','interim','history','latency-body'].map(id=>[id,$(id)]));
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let enabled=false, recognition=null, restart=null, generation=0, active=null, context=null;
  let history=[], rows=[], providers={}, speechEnd=null, provider='elevenlabs', counter=0;
  const sources=new Set();
  let nextAudio=0, odd=null;
  const notice = text => {ui.notice.textContent=text;};
  const mic = text => {ui['mic-state'].textContent=text;};
  function buttons(){ ui.start.disabled=enabled||!Recognition; ui.terminate.disabled=!enabled&&!active; ui.interrupt.disabled=!active; }
  async function resume(){
    context ||= new (window.AudioContext||window.webkitAudioContext)();
    await context.resume();
    if(context.state!=='running')throw Error('El navegador no activó la salida de audio. Pulsa Iniciar conversación.');
  }
  function stopAudio(){for(const source of sources){try{source.stop();}catch{} source.disconnect();}sources.clear();nextAudio=0;odd=null;}
  function interrupt(){generation++;if(active)active.controller.abort();active=null;stopAudio();buttons();}
  function pushPCM(chunk){
    let bytes=chunk;
    if(odd!==null){const joined=new Uint8Array(bytes.length+1);joined[0]=odd;joined.set(bytes,1);bytes=joined;odd=null;}
    if(bytes.length%2){odd=bytes.at(-1);bytes=bytes.subarray(0,-1);}
    if(!bytes.length)return null;
    if(context.state!=='running')throw Error('La salida de audio está suspendida. Vuelve a iniciar la conversación.');
    const buffer=context.createBuffer(1,bytes.length/2,22050), samples=buffer.getChannelData(0), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);
    for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
    const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);
    const start=Math.max(nextAudio,context.currentTime+0.035);nextAudio=start+buffer.duration;sources.add(source);
    source.onended=()=>{sources.delete(source);source.disconnect();};source.start(start);
    return performance.now()+(start-context.currentTime)*1000;
  }
  function log(role,text){const li=document.createElement('li');li.className=role;const label=document.createElement('span');label.className='who';label.textContent=role==='user'?'Tú':'Organima';const content=document.createElement('span');content.className='said';content.textContent=text;li.append(label,content);ui.history.append(li);while(ui.history.children.length>24)ui.history.firstChild.remove();ui.history.scrollTop=ui.history.scrollHeight;}
  function remember(role,text){history.push({role,text});history=history.slice(-12);}
  const ms=value=>value==null?'n/d':Math.round(value)+' ms';
  function record(row){rows.push(row);rows=rows.slice(-20);ui['latency-body'].replaceChildren();for(const r of rows){const tr=document.createElement('tr');for(const value of [r.id,r.provider,ms(r.transcript),ms(r.brain),ms(r.first),ms(r.playback),ms(r.fromTranscript)]){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}ui['latency-body'].append(tr);}}
  async function checked(response){if(response.ok)return response;let message='HTTP '+response.status;try{const body=await response.json();message=body.error||message;if(body.reason)message+=': '+body.reason;}catch{}throw Error(message);}
  function post(url,body,signal){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal}).then(checked);}
  function pause(ms,signal){return new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelado','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
  async function turn(raw,fromMic=false){
    const text=raw.trim();if(!text)return;
    if(text.length>1600){notice('La pregunta supera 1600 caracteres. No se envió ni se recortó.');return;}
    const finalAt=performance.now(), end=fromMic&&speechEnd!==null&&speechEnd<=finalAt?speechEnd:null;speechEnd=null;
    interrupt();const token=generation, selected=provider, controller=new AbortController();active={controller,token};buttons();notice('Organima está pensando…');
    const prior=history.slice();log('user',text);remember('user',text);
    try{
      await resume();if(token!==generation)return;
      const result=await (await post('/api/lab/turn',{message:text,history:prior},controller.signal)).json();if(token!==generation)return;
      if(typeof result.text!=='string'||!result.text.trim())throw Error('El agente devolvió una respuesta vacía.');
      log('assistant',result.text);
      if(result.text.length>1600)throw Error('La respuesta supera el límite de voz de esta prueba. Se muestra completa; pide una versión más corta.');
      remember('assistant',result.text);notice('Organima responde. Puedes interrumpirla.');
      const requested=performance.now();const response=await post('/api/lab/tts',{provider:selected,text:result.text},controller.signal);
      if(token!==generation)return;
      if(!response.body)throw Error('No llegó audio.');
      const reader=response.body.getReader();let first=null,playback=null;
      try{for(;;){const part=await reader.read();if(token!==generation){await reader.cancel();return;}if(part.done)break;if(!part.value.length)continue;first??=performance.now()-requested;const scheduled=pushPCM(part.value);if(playback===null&&scheduled!==null)playback=scheduled;}}
      finally{reader.releaseLock();}
      if(playback===null)throw Error('El proveedor devolvió audio vacío.');
      if(odd!==null)throw Error('El audio terminó con una muestra incompleta.');
      // Mantener cancelación activa hasta terminar audio, no sólo hasta EOF de red.
      while(sources.size){await pause(25,controller.signal);if(token!==generation)return;}
      record({id:++counter,provider:selected==='nvidia'?'NVIDIA':'ElevenLabs',transcript:end===null?null:finalAt-end,brain:result.brainMs,first,playback:end===null?null:playback-end,fromTranscript:playback-finalAt});
      notice(enabled?'Te escucho.':'Respuesta terminada.');
    }catch(error){if(token===generation){stopAudio();notice(error.name==='AbortError'?'Respuesta cancelada.':error.message);}}
    finally{if(token===generation){active=null;buttons();}}
  }
  function stopRecognition(){if(restart)clearTimeout(restart);restart=null;if(recognition){try{recognition.abort();}catch{}}speechEnd=null;}
  function end(){enabled=false;interrupt();stopRecognition();mic('Micrófono detenido.');notice('Conversación terminada.');buttons();}
  function setupRecognition(){
    if(recognition)return;recognition=new Recognition();recognition.lang='es-MX';recognition.continuous=true;recognition.interimResults=true;
    recognition.onstart=()=>{if(!enabled){recognition.abort();return;}mic('Escuchando… habla cuando quieras.');};
    recognition.onspeechstart=()=>{if(!enabled)return;speechEnd=null;if(active)interrupt();};
    recognition.onspeechend=()=>{if(enabled)speechEnd=performance.now();};
    recognition.onresult=event=>{if(!enabled)return;let final='',interim='';for(let i=event.resultIndex;i<event.results.length;i++){const r=event.results[i];if(r.isFinal)final+=r[0].transcript+' ';else interim+=r[0].transcript;}ui.interim.textContent=interim;if(interim.trim()&&active)interrupt();if(final.trim()){ui.interim.textContent='';void turn(final,true);}};
    recognition.onerror=event=>{if(!enabled)return;if(event.error==='no-speech'||event.error==='aborted')return;enabled=false;stopRecognition();interrupt();mic('Micrófono detenido.');notice('El transcriptor reportó '+event.error+'. Pulsa Iniciar para reintentar o usa texto.');buttons();};
    recognition.onend=()=>{if(!enabled){mic('Micrófono detenido.');return;}restart=setTimeout(()=>{restart=null;if(enabled){speechEnd=null;try{recognition.start();}catch(error){enabled=false;mic('Micrófono detenido.');notice(error.message);buttons();}}},400);};
  }
  ui.start.onclick=async()=>{if(!Recognition)return;try{await resume();enabled=true;speechEnd=null;interrupt();setupRecognition();recognition.start();notice('Usa auriculares para que Organima no se escuche a sí misma.');mic('Abriendo micrófono…');buttons();}catch(error){enabled=false;notice(error.message);buttons();}};
  ui.terminate.onclick=end;ui.interrupt.onclick=()=>{interrupt();notice('Respuesta interrumpida.');};
  ui['fallback-form'].onsubmit=event=>{event.preventDefault();const text=ui['fallback-text'].value;ui['fallback-text'].value='';void turn(text);};
  ui.provider.onchange=()=>{provider=ui.provider.value;interrupt();history=[];speechEnd=null;ui.history.replaceChildren();ui.interim.textContent='';notice('Contexto reiniciado para comparar '+provider+'.');showProvider();};
  function showProvider(){const info=providers[provider];ui['provider-note'].textContent=info?.configured?'Configurado; la disponibilidad se comprueba en cada respuesta.':(info?.reason||'Sin configuración');}
  window.addEventListener('pagehide',end);
  async function status(){try{const data=await(await checked(await fetch('/api/lab/status'))).json();providers=Object.fromEntries(data.providers.map(p=>[p.id,p]));for(const option of ui.provider.options){const p=providers[option.value];option.disabled=!p?.configured;option.textContent=(p?.label||option.value)+(p?.configured?'':' — no disponible');}showProvider();const missing=data.providers.filter(p=>!p.configured);if(missing.length)notice(missing.map(p=>p.label+': '+p.reason).join('. '));}catch(error){notice(error.message);}}
  buttons();if(!Recognition)notice('Abre esta prueba en Chrome para conversar con el micrófono.');void status();
})();
