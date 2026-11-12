'use strict';
// Resource boundaries for official probe HTTP handlers; no source parsing or health decisions.
const http = require('node:http');
const {AsyncLocalStorage} = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const routes = new Set(['/api/source/test','/api/source-list','/api/live/playlist']);
const maxBytes = 8 * 1024 * 1024;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event,...args) {
 if(event !== 'request')return emit.call(this,event,...args);
 const [req,res] = args;
 if(!routes.has(new URL(req.url,'http://localhost').pathname))return emit.call(this,event,...args);
 const controller = new AbortController();
 const abort = () => controller.abort();
 req.once('aborted',abort);
 res.once('close',()=>{if(!res.writableFinished)abort();req.removeListener('aborted',abort);});
 return scope.run(controller.signal,()=>emit.call(this,event,...args));
};
const fetch = globalThis.fetch;
globalThis.fetch = async (input,init) => {
 const signal = scope.getStore();
 if(!signal)return fetch(input,init);
 const signals=[signal,init?.signal,input instanceof Request?input.signal:null].filter(Boolean);
 const response=await fetch(input,{...init,signal:AbortSignal.any(signals)});
 if(!response.body)return response;
 const reader=response.body.getReader();
 if(Number(response.headers.get('content-length'))>maxBytes){await reader.cancel();throw new Error('测活响应超过 8 MiB 资源上限');}
 let received=0;
 const body=new ReadableStream({
  async pull(controller){
   try{const part=await reader.read();if(part.done){controller.close();return;}received+=part.value.byteLength;if(received>maxBytes){await reader.cancel();throw new Error('测活响应超过 8 MiB 资源上限');}controller.enqueue(part.value);}catch(error){controller.error(error);}
  },
  cancel(reason){return reader.cancel(reason);}
 });
 const bounded=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 Object.defineProperty(bounded,'url',{value:response.url});
 return bounded;
};
