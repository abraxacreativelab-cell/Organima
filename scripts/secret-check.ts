import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {parse} from 'dotenv';
const env=await readFile('.env','utf8').then(parse).catch(()=>({} as Record<string,string>));
const values=Object.entries(env).filter(([key,value])=>/KEY|TOKEN|SECRET/.test(key)&&value.length>=16).map(([,value])=>value);
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const bad:string[]=[];
for(const file of new Set(files)){
 const body=await readFile(file,'utf8').catch(()=>null);if(body===null)continue;
 if(values.some(v=>body.includes(v)))bad.push(file);
 if(/(?:tvly-(?:dev-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})/.test(body))bad.push(file);
}
if(bad.length){console.error('Se encontraron credenciales en archivos publicables:',[...new Set(bad)]);process.exitCode=1;}else console.log('SECRET_CHECK_OK: no configured secret values in publishable files');
