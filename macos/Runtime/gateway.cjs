'use strict';
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const {load:loadCompatibility} = require('./official-compat.cjs');
const publicPort = Number(process.env.PORT);
const corePath = process.env.LIBRETV_CORE_PATH;
const desktopPath = process.env.LIBRETV_DESKTOP_PATH;
if (!corePath || !desktopPath || !publicPort) throw new Error('Missing desktop gateway configuration');
const backends = [];
let stopping = false;
const freePort = () => new Promise((resolve,reject)=>{const socket=net.createServer();socket.once('error',reject);socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolve(port));});});
async function waitFor(port, route) {
 const deadline=Date.now()+40000;
 while(Date.now()<deadline){
  if(stopping)throw new Error('Gateway stopped');
  try {const response=await fetch(`http://127.0.0.1:${port}${route}`,{signal:AbortSignal.timeout(1000)});if(response.ok)return await response.json();}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 throw new Error(`Backend readiness timed out (${route})`);
}
function stop(code=0){if(stopping)return;stopping=true;for(const child of backends)child.kill('SIGTERM');server?.close();setTimeout(()=>process.exit(code),300).unref();}
let server;
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
(async()=>{
 const compatibility=fs.existsSync(path.join(corePath,'package.json'))?loadCompatibility(corePath):null;
 const corePort=await freePort(), desktopPort=await freePort();
 for(const [directory,port] of [[corePath,corePort],[desktopPath,desktopPort]]){
  const arguments_=directory===corePath?['--max-old-space-size=768','--require',path.join(__dirname,'official-limits.cjs'),path.join(directory,'server.js')]:['--max-old-space-size=512',path.join(directory,'server.js')];
  const child=spawn(process.execPath,arguments_,{cwd:directory,env:{...process.env,HOSTNAME:'127.0.0.1',PORT:String(port),LIBRETV_DESKTOP_ORIGIN:`http://127.0.0.1:${publicPort}`},stdio:'inherit'});
  backends.push(child);child.once('error',error=>{console.error(error);stop(1);});child.once('exit',()=>{if(!stopping)stop(1);});
 }
 await Promise.all([waitFor(corePort,'/api/status'),waitFor(desktopPort,'/api/desktop/status')]);
 server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  const overlay=compatibility&&[compatibility,...(compatibility.additional||[])].find(item=>pathname===item.path);
  if(overlay){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:overlay.body);return;}
  const addon=pathname==='/desktop'||pathname.startsWith('/desktop/')||pathname.startsWith('/desktop-assets/')||pathname.startsWith('/api/desktop/');
  const upstreamPath=pathname.startsWith('/desktop-assets/')?req.url.replace('/desktop-assets/','/'):req.url;
  if(pathname==='/api/desktop/status'){
   Promise.all([fetch(`http://127.0.0.1:${corePort}/api/status`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json()),fetch(`http://127.0.0.1:${desktopPort}/api/desktop/status`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json())]).then(([core,desktop])=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...desktop,version:core.version,architecture:'official-core+desktop-addon',compatibility:compatibility?.id||null,corePort,desktopPort}));}).catch(error=>{res.writeHead(503);res.end(JSON.stringify({error:error.message}));});return;
  }
  const headers={...req.headers}; delete headers.connection;
  headers['accept-encoding']='identity';
  headers['x-forwarded-host']=req.headers.host;headers['x-forwarded-proto']='http';
  const upstream=http.request({hostname:'127.0.0.1',port:addon?desktopPort:corePort,path:upstreamPath,method:req.method,headers},reply=>{
   if(!addon&&compatibility&&['/','/live','/watch','/about'].includes(pathname)&&String(reply.headers['content-type']).includes('text/html')){
    const chunks=[];reply.on('data',chunk=>chunks.push(chunk));reply.on('end',()=>{const responseHeaders={...reply.headers,'cache-control':'no-store'};delete responseHeaders['content-length'];delete responseHeaders.etag;let html=Buffer.concat(chunks).toString('utf8');for(const asset of [compatibility,...(compatibility.additional||[])])html=html.replaceAll(asset.path,asset.path+'?libretvDesktopCompat='+compatibility.id);res.writeHead(reply.statusCode,responseHeaders);res.end(html);});
   }else{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);}
  });
  upstream.on('error',error=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'本地服务连接失败：'+error.message}));});
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});req.pipe(upstream);
 });
 server.requestTimeout=0;
 server.listen(publicPort,'127.0.0.1',()=>console.log(`LibreTV local gateway ready on 127.0.0.1:${publicPort}`));
})().catch(error=>{console.error(error);stop(1);});
