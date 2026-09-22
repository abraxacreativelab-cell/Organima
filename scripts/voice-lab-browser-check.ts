import {chromium} from '@playwright/test';
import {createVoiceLab} from '../src/voice-lab.ts';
import express from 'express';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const lab=createVoiceLab({env:{ELEVENLABS_API_KEY:'test',ELEVENLABS_VOICE_ID:'test'},reply:async()=>({text:'Respuesta breve de prueba.',model:'test',mode:'live',sources:[]}),fetcher:async()=>new Response(new Uint8Array(22050*2*2),{headers:{'content-type':'audio/pcm'}})});
lab.app.use(express.static('public',{index:'voice-lab.html'}));const server=lab.app.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address() as any;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage({viewport:{width:1440,height:1050}});page.setDefaultTimeout(10000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript({content:"window.SpeechRecognition=class {constructor(){window.testRec=this;}start(){this.onstart?.();}abort(){this.onend?.();}};"});
try{
 await page.goto(`http://127.0.0.1:${addr.port}`);await page.waitForFunction(()=>document.querySelector('option[value=nvidia]')?.hasAttribute('disabled'));
 await page.locator('#start').click();await page.waitForFunction(()=>Boolean((window as any).testRec));
 const speak=async()=>page.evaluate(()=>{const r=(window as any).testRec;r.onspeechstart();r.onspeechend();r.onresult({resultIndex:0,results:[Object.assign([{transcript:'Hola, cómo estás'}],{isFinal:true})]});});
 await speak();await page.waitForFunction(()=>document.querySelectorAll('#history li').length===2);await page.waitForTimeout(300);assert.equal(await page.locator('#interrupt').isEnabled(),true);await page.locator('#interrupt').click();await page.waitForTimeout(2100);assert.equal(await page.locator('#latency-body tr').count(),0);
 await speak();await page.waitForFunction(()=>document.querySelectorAll('#latency-body tr').length===1);assert.equal(await page.locator('#latency-body td').count(),7);assert.match(await page.locator('#latency-body').innerText(),/ElevenLabs/);
 await page.screenshot({path:'runtime/voice-lab-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'runtime/voice-lab-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('#terminate').click();const count=await page.locator('#history li').count();await speak();await page.waitForTimeout(100);assert.equal(await page.locator('#history li').count(),count);assert.deepEqual(errors,[]);
 console.log('VOICE_BROWSER_OK: auto-submit, incremental PCM, interruption after network EOF, seven metrics columns, no turn after termination, mobile width. Recognition and providers simulated; not a real microphone latency measurement.');
}finally{await browser.close();lab.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
