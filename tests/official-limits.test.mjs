import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('official probes cancel upstream work on disconnect and bound large responses without limiting media routes',async()=>{
 let closed=false;
 const upstream=http.createServer((req,res)=>{
  if(req.url==='/slow'){res.on('close',()=>closed=true);return;}
  res.writeHead(200,{'Content-Type':'text/plain'});res.end(Buffer.alloc(9*1024*1024,120));
 });
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const port=upstream.address().port;
 const child=spawn(process.execPath,['--require',path.resolve('macos/Runtime/official-limits.cjs'),'-e',`
 const http=require('node:http');http.createServer(async(req,res)=>{try{const response=await fetch('http://127.0.0.1:${port}/'+(req.url.includes('slow')?'slow':'large'));const body=await response.text();res.end(String(body.length));}catch(error){res.statusCode=413;res.end(error.message);}}).listen(0,'127.0.0.1',function(){console.log(this.address().port)});
 `],{stdio:['ignore','pipe','pipe']});
 try {
  const address=await new Promise((resolve,reject)=>{child.stdout.once('data',data=>resolve(Number(data.toString().trim())));child.once('error',reject);});
  const large=await fetch(`http://127.0.0.1:${address}/api/source/test`);assert.equal(large.status,413);assert.match(await large.text(),/8 MiB/);
  const media=await fetch(`http://127.0.0.1:${address}/api/proxy/media`);assert.equal(await media.text(),String(9*1024*1024));
  const controller=new AbortController(),request=fetch(`http://127.0.0.1:${address}/api/source/test?slow=1`,{signal:controller.signal}).catch(()=>{});
  await wait(50);controller.abort();await request;
  for(let i=0;i<30&&!closed;i++)await wait(10);
  assert.equal(closed,true,'disconnect must release the real upstream connection');
 } finally {child.kill('SIGTERM');upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
});
