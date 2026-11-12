import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(predicate,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await wait(50);}throw new Error('lifecycle condition timed out');}
async function fixture(parentDeath=false){
 const dir=await mkdtemp(path.join(tmpdir(),'libretv-process-test-'));
 let host,pids;
 try {
  if(parentDeath){
   const source=`const{spawn}=require('node:child_process');const host=spawn(process.execPath,[${JSON.stringify(path.join(root,'macos/Runtime/service-host.cjs'))},${JSON.stringify(path.join(root,'tests/fixtures/process-tree.cjs'))}],{env:{...process.env,LIBRETV_DESKTOP_PARENT_PID:String(process.pid)},stdio:'ignore'});require('node:fs').writeFileSync(process.env.HOST_PID,String(host.pid));setInterval(()=>{},1000);`;
   host=spawn(process.execPath,['-e',source],{env:{...process.env,FIXTURE_PIDS:path.join(dir,'pids.json'),HOST_PID:path.join(dir,'host.pid')},stdio:'ignore'});
  }else host=spawn(process.execPath,[path.join(root,'macos/Runtime/service-host.cjs'),path.join(root,'tests/fixtures/process-tree.cjs')],{env:{...process.env,LIBRETV_DESKTOP_PARENT_PID:String(process.pid),LIBRETV_DESKTOP_STATE_PATH:path.join(dir,'state.json'),FIXTURE_PIDS:path.join(dir,'pids.json')},stdio:'ignore'});
  await until(async()=>{try{pids=JSON.parse(await readFile(path.join(dir,'pids.json'),'utf8'));return !!pids.leaf;}catch{return false;}});
  assert.ok(alive(pids.root));assert.ok(alive(pids.leaf));
  host.kill(parentDeath?'SIGKILL':'SIGTERM');
  await until(()=>!alive(pids.root)&&!alive(pids.leaf));
  if(parentDeath){const supervisor=Number(await readFile(path.join(dir,'host.pid'),'utf8'));await until(()=>!alive(supervisor));}
 }finally{host?.kill('SIGKILL');if(pids){for(const pid of [pids.root,pids.leaf]){try{process.kill(pid,'SIGKILL');}catch{}}}await rm(dir,{recursive:true,force:true});}
}
test('closing the app kills the entire owned group, including a child ignoring SIGTERM',()=>fixture());
test('a force-terminated app leaves no service or helper behind',()=>fixture(true));
