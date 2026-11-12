import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
const root=path.resolve(import.meta.dirname,'..');
const free=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('one stable origin routes official pages and APIs separately from desktop additions',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'libretv-gateway-test-'));let child;
 try{
  const script=`const http=require('node:http'),path=require('node:path');const label=path.basename(process.cwd());http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:'2.22.0',instance:process.env.LIBRETV_DESKTOP_INSTANCE,label,path:req.url,cookie:req.headers.cookie,host:req.headers.host}));}).listen(Number(process.env.PORT),'127.0.0.1');`;
  for(const name of ['Core','Desktop']){await mkdir(path.join(directory,name));await writeFile(path.join(directory,name,'server.js'),script);}
  const port=await free(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,[path.join(root,'macos/Runtime/service-host.cjs'),path.join(root,'macos/Runtime/gateway.cjs')],{env:{...process.env,PORT:String(port),LIBRETV_DESKTOP_PARENT_PID:String(process.pid),LIBRETV_DESKTOP_INSTANCE:'routing-test',LIBRETV_CORE_PATH:path.join(directory,'Core'),LIBRETV_DESKTOP_PATH:path.join(directory,'Desktop')},stdio:'ignore'});
  let status;
  for(let i=0;i<80;i++){try{const response=await fetch(base+'/api/desktop/status');status=await response.json();break;}catch{await pause(50);}}
  assert.equal(status.architecture,'official-core+desktop-addon');
  for(const [route,label,upstreamPath] of [['/','Core','/'],['/watch?url=x','Core','/watch?url=x'],['/api/search','Core','/api/search'],['/desktop?view=discover','Desktop','/desktop?view=discover'],['/api/desktop/cache','Desktop','/api/desktop/cache'],['/desktop-assets/_next/static/test.js','Desktop','/_next/static/test.js']]){
   const result=await (await fetch(base+route,{headers:{Cookie:'private-local-session=test'}})).json();assert.equal(result.label,label);assert.equal(result.path,upstreamPath);assert.equal(result.cookie,'private-local-session=test');assert.equal(result.host,`127.0.0.1:${port}`);
  }
  child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
  await assert.rejects(fetch(base+'/api/status',{signal:AbortSignal.timeout(500)}));
 }finally{child?.kill('SIGKILL');await rm(directory,{recursive:true,force:true});}
});
test('only official UI HTML is buffered for overlays; arbitrary proxy HTML streams unchanged',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'libretv-gateway-stream-'));let child;
 try{
  const script=`const http=require('node:http');let pending;http.createServer((req,res)=>{if(req.url==='/api/proxy/fixture'){res.writeHead(200,{'Content-Type':'text/html'});res.write('untrusted /_next/static/chunks/354-fe055eb932927f43.js');pending=res;return;}if(req.url==='/release-stream'){pending?.end(' tail');res.end('released');return;}if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('/_next/static/chunks/354-fe055eb932927f43.js');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:'2.22.0'}));}).listen(Number(process.env.PORT),'127.0.0.1');`;
  for(const name of ['Core','Desktop']){await mkdir(path.join(directory,name));await writeFile(path.join(directory,name,'server.js'),script);}
  await writeFile(path.join(directory,'Core/package.json'),JSON.stringify({version:'2.22.0'}));
  for(const file of ['354-fe055eb932927f43.js','312-532e92dc3e2bcf7f.js','app/layout-45a4982cfa62ca6c.js']){
   const target=path.join(directory,'Core/.next/static/chunks',file);await mkdir(path.dirname(target),{recursive:true});
   await writeFile(target,await readFile(path.join(root,'build/official/2.22.0/Core/.next/static/chunks',file)));
  }
  await writeFile(path.join(directory,'Core/.next/static/chunks/contracts.js'),'libretv-video-v1 libretv-dl-v1 showSaveFilePicker libretv:add-download libretv:show-download-manager libretv-settings');
  const port=await free(),base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,[path.join(root,'macos/Runtime/service-host.cjs'),path.join(root,'macos/Runtime/gateway.cjs')],{env:{...process.env,PORT:String(port),LIBRETV_DESKTOP_PARENT_PID:String(process.pid),LIBRETV_CORE_PATH:path.join(directory,'Core'),LIBRETV_DESKTOP_PATH:path.join(directory,'Desktop')},stdio:'ignore'});
  let ready=false;for(let i=0;i<80;i++){try{const response=await fetch(base+'/api/desktop/status');if(response.ok){ready=true;break;}}catch{}await pause(50);}
  assert.equal(ready,true);
  const html=await (await fetch(base+'/')).text();assert.match(html,/libretvDesktopCompat=official-2.22.0-desktop-compat-v7/);
  // The backend deliberately keeps the response open: buffering would time out.
  const response=await fetch(base+'/api/proxy/fixture',{signal:AbortSignal.timeout(2000)}),reader=response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'untrusted /_next/static/chunks/354-fe055eb932927f43.js');
  await fetch(base+'/release-stream');await reader.cancel();
 }finally{if(child&&!child.killed){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await rm(directory,{recursive:true,force:true});}
});
