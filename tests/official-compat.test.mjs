import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {artifact,patch}=require('../macos/Runtime/official-compat.cjs');
const source=await readFile(new URL('../build/official/2.22.0/Core/.next/static/chunks/354-fe055eb932927f43.js',import.meta.url),'utf8');
const patched=patch(source);
new vm.Script(patched); // Verify every exact replacement still parses as JavaScript.
function engine(text){return text.slice(text.indexOf('async function N(e)'),text.indexOf('let A="libretv-download-settings"'));}
async function download(text,count){
 const chunks=new Map(),fetched=[],written=[];let closed=false;
 const environment={AbortController,AbortSignal,Request,Response,Uint8Array,Error,Promise,encodeURIComponent,
  c:{Y7:()=>false,Z0:'/api/proxy/'},u:{F7:async()=>({segments:Array.from({length:count},(_,i)=>({url:'https://fixture.test/'+(i+1)})),totalDuration:count*6})},g:()=>true,y:'libretv-dl-v1',w:'https://dl.libretv.local',
  caches:{open:async()=>({match:async r=>chunks.get(r.url)?.clone(),put:async(r,response)=>chunks.set(r.url,response.clone())})},
  k:async(url,index)=>{fetched.push(url);return new Uint8Array([index]).buffer;}
 };
 const run=vm.runInNewContext(engine(text)+';N',environment);
 await run({taskId:'regression',url:'https://fixture.test/sample.m3u8',format:'TS',concurrency:8,signal:new AbortController().signal,pause:{waitIfPaused:async()=>{}},onProgress:()=>{},target:{write:async bytes=>written.push(...bytes),close:async()=>{closed=true;}}});
 return {fetched,written,closed};
}
test('reproduces official worker overrun and fixes short HLS playlists without replacing the downloader',async()=>{
 await assert.rejects(download(source,3),/url/);
 for(const count of [1,3,17]){const result=await download(patched,count);assert.equal(result.fetched.length,count);assert.deepEqual(result.written,Array.from({length:count},(_,i)=>i+1));assert.equal(result.closed,true);}
});
test('paused jobs resume their existing controller without opening another output file',async()=>{
 const start=patched.indexOf('let P=async e=>'),end=patched.indexOf(',T=async e=>',start);
 let resumed=0,picked=0;const updates=[];
 const control=vm.runInNewContext(patched.slice(start,end)+';P',{x:{current:new Map([['job',{pause:{resume:()=>resumed++}}]])},k:async(id,value)=>updates.push(value),I:async()=>{picked++;return {};}});
 await control({id:'job',status:'paused'});assert.equal(resumed,1);assert.equal(picked,0);assert.deepEqual(JSON.parse(JSON.stringify(updates)),[{status:'downloading'}]);
});
test('rejects any artifact whose versioned SHA-256 differs',()=>{assert.throws(()=>patch(source+'\n'),/differs/);assert.equal(artifact.version,'2.22.0');});
test('official source probe survives component unmount and remount without restarting the job',async()=>{
 const {patchSettings}=require('../macos/Runtime/official-compat.cjs');
 const raw=await readFile(new URL('../build/official/2.22.0/Core/.next/static/chunks/312-532e92dc3e2bcf7f.js',import.meta.url),'utf8');
 const code=patchSettings(raw);new vm.Script(code);
 const start=code.indexOf('isProbing:k}=function(){')+'isProbing:k}='.length;
 const end=code.indexOf('}(),w=',start)+1;
 let cleanups=[],state,release,calls=0,health=[];
 const context={Set,Date,Promise,Error,globalThis:{},r:{useState:initial=>{state=initial;return[initial,value=>state=value];},useEffect:fn=>cleanups.push(fn()),useCallback:fn=>fn},b:{FH:{testSource:async()=>{calls++;await new Promise(resolve=>release=resolve);return {ok:true,ms:1};}}},x:{CU:{getState:()=>({recordSourceHealth:rows=>health.push(...rows)})}}};
 const hook=vm.runInNewContext('('+code.slice(start,end)+')',context);
 const first=hook();const running=first.probe([{key:'a',url:'https://fixture.test'}]);
 assert.equal(state.total,1);cleanups.forEach(fn=>fn());cleanups=[];
 const second=hook();assert.equal(second.isProbing,true);assert.equal(second.progress.total,1);
 release();await running;
 assert.equal(calls,1);assert.equal(health.length,1);assert.equal(state,null);
 assert.throws(()=>patchSettings(raw+'\n'),/differs/);
});
test('download completion waits for earlier progress writes instead of being overwritten by downloading',async()=>{
 async function run(code){
  let status;const x={current:new Map()};
  const write=async(_,patch)=>{await new Promise(resolve=>setTimeout(resolve,patch.status==='downloading'?20:0));status=patch.status;};
  const begin=code.indexOf('let j=(0,i.useCallback)(')+'let j=(0,i.useCallback)('.length;
  const end=code.indexOf(',[c,k,y])',begin);
  const target={abort:async()=>{}};
  const environment={AbortController,Date,Promise,Error,globalThis:{__dlSaveTarget:{id:'job',target},__ltDownloadTargets:new Map([['job',{target}]])},x,v:class{getPaused(){return false;}},k:write,y:false,d:()=>{},l:{db:{constructor:{ignoreTransaction:fn=>fn()},downloads:{update:write}}},N:async options=>{options.onProgress({status:'downloading',current:1,total:1});options.onProgress({status:'processing',current:1,total:1});options.onProgress({status:'done',current:1,total:1});},b:()=>{},c:()=>{},E:()=>{}};
  const start=vm.runInNewContext('('+code.slice(begin,end)+')',environment);
  await start({id:'job',format:'MP4'},true);await new Promise(resolve=>setTimeout(resolve,100));return status;
 }
 assert.equal(await run(source),'downloading','reproduce the real late-write regression');
 assert.equal(await run(patched),'completed');
});
test('official theme context follows native changes and shared storage without reloading the document',async()=>{
 const {patchSettings}=require('../macos/Runtime/official-compat.cjs');
 const raw=await readFile(new URL('../build/official/2.22.0/Core/.next/static/chunks/312-532e92dc3e2bcf7f.js',import.meta.url),'utf8');
 const code=patchSettings(raw),start=code.indexOf('function c(e){let{children:t}=e,[s,c]'),end=code.indexOf('function o(){let{theme:',start);
 const listeners=new Map(),storage=new Map([['libretv-theme','dark']]),state=[];let cursor=0,effectInstalled=false;
 const media={matches:false,addEventListener(){},removeEventListener(){}};
 const window={matchMedia:()=>media,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const provider=vm.runInNewContext('('+code.slice(start,end)+')',{
  window,localStorage:{getItem:key=>storage.get(key)||null},a:'libretv-theme',r:{Provider:'provider'},n:{jsx:(_,props)=>props},
  i:choice=>choice==='system'?(media.matches?'dark':'light'):choice,
  l:{useState:initial=>{const index=cursor++;if(!(index in state))state[index]=initial;return[state[index],value=>state[index]=value];},useEffect:fn=>{if(!effectInstalled){effectInstalled=true;fn();}},useCallback:fn=>fn}
 });
 const render=()=>{cursor=0;return provider({children:null}).value;};
 assert.equal(render().theme,'dark');
 storage.set('libretv-theme','light');listeners.get('libretv:desktop-theme')({type:'libretv:desktop-theme'});
 assert.equal(render().theme,'light');assert.equal(render().resolved,'light');
 storage.set('libretv-theme','system');listeners.get('storage')({type:'storage',key:'libretv-theme'});
 assert.equal(render().theme,'system');assert.equal(render().resolved,'light');
});
test('the separately bundled official layout theme also follows native changes',async()=>{
 const {patchLayout,layoutArtifact}=require('../macos/Runtime/official-compat.cjs');
 const raw=await readFile(new URL('../build/official/2.22.0/Core/.next/static/chunks/app/layout-45a4982cfa62ca6c.js',import.meta.url),'utf8');
 const code=patchLayout(raw);new vm.Script(code);
 const start=code.indexOf('function i(e){let{children:t}=e,[r,i]'),end=code.indexOf('function c(){let{theme:',start);
 const listeners=new Map(),storage=new Map([['libretv-theme','dark']]),state=[];let cursor=0,effectInstalled=false;
 const media={matches:false,addEventListener(){},removeEventListener(){}};
 const provider=vm.runInNewContext('('+code.slice(start,end)+')',{
  window:{matchMedia:()=>media,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},
  localStorage:{getItem:key=>storage.get(key)||null},o:'libretv-theme',a:{Provider:'provider'},s:{jsx:(_,props)=>props},
  l:choice=>choice==='system'?(media.matches?'dark':'light'):choice,
  n:{useState:initial=>{const index=cursor++;if(!(index in state))state[index]=initial;return[state[index],value=>state[index]=value];},useEffect:fn=>{if(!effectInstalled){effectInstalled=true;fn();}},useCallback:fn=>fn}
 });
 const render=()=>{cursor=0;return provider({children:null}).value;};
 assert.equal(render().theme,'dark');storage.set('libretv-theme','light');listeners.get('libretv:desktop-theme')({type:'libretv:desktop-theme'});
 assert.equal(render().theme,'light');assert.equal(render().resolved,'light');
 assert.throws(()=>patchLayout(raw+'\n'),/differs/);assert.equal(layoutArtifact.file.endsWith('layout-45a4982cfa62ca6c.js'),true);
});
