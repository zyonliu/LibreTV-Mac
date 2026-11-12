import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
const resources=process.env.LIBRETV_TEST_RESOURCES||path.resolve(import.meta.dirname,'../build/LibreTV.app/Contents/Resources');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const free=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
test('a force-killed parent reclaims the actual bundled gateway, official core, addon and ports',async t=>{
 try{await access(path.join(resources,'Runtime/node'));}catch{t.skip('Build the macOS bundle first');return;}
 const temp=await mkdtemp(path.join(tmpdir(),'libretv-real-lifecycle-')),state=path.join(temp,'state.json'),port=await free();let parent,pids,status;
 try{
  await writeFile(path.join(temp,'config.json'),JSON.stringify({cacheDirectory:path.join(temp,'cache'),downloadDirectory:path.join(temp,'downloads')}));
  const script=`const{spawn}=require('node:child_process');const child=spawn(process.execPath,[process.env.SUPERVISOR,process.env.GATEWAY],{env:{...process.env,LIBRETV_DESKTOP_PARENT_PID:String(process.pid)},stdio:'ignore'});require('node:fs').writeFileSync(process.env.HOST_PID,String(child.pid));setInterval(()=>{},1000);`;
  parent=spawn(path.join(resources,'Runtime/node'),['-e',script],{env:{PATH:'/usr/bin:/bin',HOME:temp,SUPERVISOR:path.join(resources,'Runtime/service-host.cjs'),GATEWAY:path.join(resources,'Runtime/gateway.cjs'),HOST_PID:path.join(temp,'host.pid'),LIBRETV_DESKTOP_STATE_PATH:state,LIBRETV_CORE_PATH:path.join(resources,'Core'),LIBRETV_DESKTOP_PATH:path.join(resources,'Desktop'),LIBRETV_DESKTOP_CONFIG:path.join(temp,'config.json'),LIBRETV_DESKTOP_INSTANCE:'real-isolated-test',LIBRETV_DESKTOP_API_KEY:'isolated-test-key',PASSWORD:'isolated-test-password',PORT:String(port),COOKIE_SECURE:'false',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'},stdio:'ignore'});
  for(let i=0;i<100;i++){try{const response=await fetch(`http://127.0.0.1:${port}/api/desktop/status`,{signal:AbortSignal.timeout(500)});if(response.ok){status=await response.json();pids=JSON.parse(await readFile(state,'utf8'));break;}}catch{}await sleep(100);}
  assert.equal(status?.architecture,'official-core+desktop-addon');assert.equal(status.version,'2.22.0');assert.equal(status.compatibility,'official-2.22.0-desktop-compat-v7');
  parent.kill('SIGKILL');
  for(let i=0;i<80&&(alive(pids.supervisor)||alive(pids.service));i++)await sleep(50);
  assert.equal(alive(pids.supervisor),false);assert.equal(alive(pids.service),false);
  for(const closed of [port,status.corePort,status.desktopPort])await assert.rejects(fetch(`http://127.0.0.1:${closed}/api/status`,{signal:AbortSignal.timeout(500)}));
 }finally{parent?.kill('SIGKILL');if(pids){try{process.kill(-pids.group,'SIGKILL');}catch{}}await rm(temp,{recursive:true,force:true});}
});
