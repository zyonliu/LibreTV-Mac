Object.defineProperty(window,"__ltNativePromise",{value:Promise});
(() => {
  const native = window.libreTVDesktop;
  if (!native) return;
  const original = window.fetch.bind(window), running = new Map();
  window.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !['/api/source/test','/api/live/playlist','/api/source-list'].includes(url.pathname) || url.searchParams.get('format') === 'm3u') return original(input, options);
    const request = new Request(input instanceof Request ? input : url.href, options);
    const signal = options?.signal || request.signal;
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const id = crypto.randomUUID();
    running.set(id,url.pathname);
    const abort = () => native.call('official.probe.cancel', {id}).catch(() => {});
    signal.addEventListener('abort', abort, {once:true});
    try {
      const body = request.method === 'GET' ? undefined : await request.text();
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const result = await native.call('official.probe', {id, path:url.pathname + url.search, method:request.method, body});
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      return new Response(result.body, {status:result.status, headers:{'Content-Type':'application/json'}});
    } catch (error) { if (signal.aborted) throw new DOMException('已取消', 'AbortError'); throw error; }
    finally { signal.removeEventListener('abort', abort); running.delete(id); }
  };
  window.__ltCancelOfficialProbes = () => { for (const [id,path] of running) if(path === '/api/source/test') native.call('official.probe.cancel',{id}).catch(()=>{}); };
  const stop = () => { for (const id of running.keys()) native.call('official.probe.cancel', {id}).catch(() => {}); };
  addEventListener('pagehide', stop); addEventListener('libretv:desktop-terminate', stop);
})();
(() => {
  const native = window.libreTVDesktop;
  if (!native) return;
  const base64 = data => { let text = ''; for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192)); return btoa(text); };
  const openTargets=new Set();
  addEventListener('pagehide',()=>{for(const id of openTargets)native.call('download.abort',{id}).catch(()=>{});openTargets.clear();});
  // Standard browser file API, supplied by the host. Official LibreTV remains unmodified.
  if (!window.showSaveFilePicker) Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async options => {
    let target;
    try { target = await native.call('download.begin', {filename: options?.suggestedName || 'LibreTV-download'}); }
    catch (error) { if(String(error?.message || error).includes('取消'))throw new DOMException('已取消保存','AbortError');throw error; }
    openTargets.add(target.id);
    return {createWritable: async () => new WritableStream({
      async write(chunk) {
        if (chunk?.type === 'write') chunk = chunk.data;
        const data = chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for(let i=0;i<data.length;i+=256*1024) await native.call('download.write',{id:target.id,data:base64(data.subarray(i,i+256*1024))});
      },
      async close(){await native.call('download.close',{id:target.id});openTargets.delete(target.id);}, async abort(){await native.call('download.abort',{id:target.id});openTargets.delete(target.id);}
    })};
  }});
  if (!window.caches) return;
  const managed = new Set(['libretv-video-v1','libretv-dl-v1']);
  const keyOf = input => new URL(typeof input==='string'?input:input.url,location.href).href;
  const api = async (action, params={}) => {
    const response=await fetch('/api/desktop/cache',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...params})});
    const data=await response.json();if(!response.ok)throw new Error(data.error || '媒体缓存操作失败');return data;
  };
  const originalOpen=caches.open.bind(caches), originalDelete=caches.delete.bind(caches), originalHas=caches.has.bind(caches), originalKeys=caches.keys.bind(caches);
  caches.open=async name=> {
    if(!managed.has(name))return originalOpen(name);
    return {
      async match(input){const response=await fetch('/api/desktop/cache?key='+encodeURIComponent(keyOf(input)));return response.ok?response:undefined;},
      async put(input,response){const key=keyOf(input), data=await response.arrayBuffer(); const params=new URLSearchParams({key,episode:key.startsWith('https://dl.libretv.local/')?'download:'+key.split('/')[3]:key,index:'0',cost:'150'});const result=await fetch('/api/desktop/cache?'+params,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:data});if(!result.ok || !(await result.json()).ok)throw new DOMException('媒体缓存达到配额或磁盘不可写','QuotaExceededError');},
      async delete(input){await api('removeKey',{key:keyOf(input)});return true;},
      async keys(){const {keys}=await api('keys',{bucket:name});return keys.map(key=>new Request(key));}
    };
  };
  caches.delete=async name=>{if(!managed.has(name))return originalDelete(name);await api('clearBucket',{bucket:name});return true;};
  caches.has=async name=>managed.has(name)?true:originalHas(name);
  caches.keys=async()=>[...new Set([...(await originalKeys()),...managed])];
})();
(() => {
 if(location.pathname.startsWith('/desktop') || window.top !== window)return;
 // No private React state: interrupted task records use the same versioned IndexedDB contract as backups.
 const pauseRecords=async()=>{
  const list=await indexedDB.databases();if(!list.some(db=>db.name==='libretv'&&db.version===30))return;
  await new Promise((resolve,reject)=>{
   const request=indexedDB.open('libretv',30);request.onerror=()=>reject(request.error);
   request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains('downloads')){db.close();resolve();return;}
    const transaction=db.transaction('downloads','readwrite'),store=transaction.objectStore('downloads'),cursor=store.openCursor();
    cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(['downloading','waiting'].includes(row.value.status)){row.value.status='paused';row.value.updatedAt=Date.now();row.update(row.value);}row.continue();};
    transaction.oncomplete=()=>{db.close();resolve();};transaction.onerror=()=>{db.close();reject(transaction.error);};
   };
  });
 };
 window.__ltPauseDownloads=pauseRecords;
 addEventListener('load',()=>pauseRecords().catch(()=>{}),{once:true});
})();
(() => {
 const bridge=window.libreTVDesktop;if(!bridge)return;
 const set=Storage.prototype.setItem,get=Storage.prototype.getItem;
 let serial=0,latest=null;
 const media=matchMedia('(prefers-color-scheme: dark)');
 const apply=prefs=>{
  if(!prefs||!['light','dark','system'].includes(prefs.appearance))return;
  serial++;latest=prefs;
  if(get.call(localStorage,'libretv-theme')!==prefs.appearance)set.call(localStorage,'libretv-theme',prefs.appearance);
  document.documentElement.dataset.desktopMode=prefs.hostMode||'desktop';
  const dark=prefs.appearance==='dark'||(prefs.appearance==='system'&&media.matches);
  if(location.pathname.startsWith('/desktop')){
   for(const name of [...document.documentElement.style])if(name.startsWith('--c-'))document.documentElement.style.removeProperty(name);
   if(prefs.paletteAppearance===(dark?'dark':'light'))for(const [name,value] of Object.entries(prefs.palette||{}))document.documentElement.style.setProperty('--c-'+name,value);
  }
  if(document.documentElement.classList.contains('dark')!==dark)document.documentElement.classList.toggle('dark',dark);
  window.dispatchEvent(new CustomEvent('libretv:desktop-theme',{detail:prefs.appearance}));
  for(const frame of document.querySelectorAll('iframe[src]')){
   try{
    const url=new URL(frame.src,location.href);
    if(url.origin!==location.origin||!['settings','history'].includes(url.searchParams.get('desktopPanel')))continue;
    frame.contentWindow?.__ltApplyDesktopPreferences?.(prefs);
   }catch{ /* Foreign frames never receive native preferences. */ }
  }
 };
 window.__ltApplyDesktopPreferences=apply;
 const sync=()=>{const ticket=++serial;return bridge.call('preferences.get').then(prefs=>{if(ticket===serial)apply(prefs);}).catch(()=>{});};
 Storage.prototype.setItem=function(key,value){
  const changed=this===localStorage&&get.call(this,key)!==String(value);set.call(this,key,value);
  if(changed&&key==='libretv-theme'&&['light','dark','system'].includes(String(value)))bridge.call('preferences.set',{appearance:String(value)}).then(sync).catch(()=>{});
 };
 addEventListener('libretv:desktop-preferences',sync);
 addEventListener('libretv:desktop-resume',sync);
 addEventListener('DOMContentLoaded',sync,{once:true});
 media.addEventListener('change',()=>{if(latest?.appearance==='system')apply(latest);});
 sync();
})();
(() => {
 const host=window.libreTVDesktop;if(!host)return;
 const setup=()=>{
  const style=document.createElement('style');style.textContent=`
   html[data-desktop-mode="desktop"] header:has(a[aria-label="LibreTV 首页"]){display:none!important}
   /* Keep the native menu. Its width must not turn an otherwise desktop-sized
      official live page into a channel drawer. Narrow windows keep that drawer. */
   @media (min-width:768px) and (max-width:1023px){
    html[data-desktop-mode="desktop"] main>div:has(>aside [data-channel-list]){grid-template-columns:minmax(0,1fr) 320px!important}
    html[data-desktop-mode="desktop"] main>div:has(>aside [data-channel-list])>aside{display:flex!important;position:sticky!important;inset:auto!important;top:5rem!important;height:calc(100vh - 6.5rem)!important;border-radius:.75rem!important;box-shadow:none!important}
    html[data-desktop-mode="desktop"] main>div:has(>aside [data-channel-list])>aside>div:has(>button[aria-label="关闭频道列表"]),
    html[data-desktop-mode="desktop"] main>div:has(>aside [data-channel-list])>div[aria-hidden="true"][class~="lg:hidden"],
    html[data-desktop-mode="desktop"] main:has(>div>aside [data-channel-list])>button[class~="lg:hidden"]{display:none!important}
   }
  `;document.head.append(style);
  const palette=()=>{if(location.pathname.startsWith('/desktop'))return;const css=getComputedStyle(document.documentElement),colors={};for(const name of ['page','surface','surface-raised','line','content','muted','faint','accent','accent-hover','hover','chip','on-accent','danger','success','warning'])colors[name]=css.getPropertyValue('--c-'+name).trim().replace(/\s+/g,' ');host.call('ui.palette',{colors,appearance:localStorage.getItem('libretv-theme'),resolved:document.documentElement.classList.contains('dark')?'dark':'light'}).catch(()=>{});};
  new MutationObserver(palette).observe(document.documentElement,{attributes:true,attributeFilter:['class']});addEventListener('load',palette);matchMedia('(prefers-color-scheme: dark)').addEventListener('change',palette);palette();
 };
 if(document.readyState==='loading')addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})();
(() => {
 const native=window.libreTVDesktop;if(!native)return;
 const play=HTMLMediaElement.prototype.play;
 HTMLMediaElement.prototype.play=function(){
  const gesture=!!navigator.userActivation?.isActive;
  return native.call('media.canPlay',{userGesture:gesture}).then(allowed=>{if(!allowed)throw new DOMException('当前页面已暂停，请在前台手动恢复播放','NotAllowedError');return play.call(this);});
 };
})();
(() => {
 const kind=new URLSearchParams(location.search).get('desktopPanel');
 if(!['settings','history'].includes(kind))return;
 const title=kind==='settings'?'设置':'观看历史';let opened=false;
 const setup=()=>{
  document.documentElement.dataset.desktopPanel=kind;
  const style=document.createElement('style');style.textContent=`
   html[data-desktop-panel] body>*{visibility:hidden}
   html[data-desktop-panel] [data-official-panel],html[data-desktop-panel] [data-official-panel] *,html[data-desktop-panel] [role=alertdialog],html[data-desktop-panel] [role=alertdialog] *,html[data-desktop-panel] [role=status]{visibility:visible}
   html[data-desktop-panel] [data-official-panel]{position:fixed!important;inset:0!important;width:100%!important;max-width:none!important;height:100dvh!important;max-height:100dvh!important;transform:none!important;transition:none!important;border:0!important;border-radius:0!important}
   html[data-desktop-panel] [data-official-panel]>div:has(>h2)>button[aria-label="关闭"]{display:none!important}
   html[data-desktop-panel] [data-official-panel]>[aria-hidden]{display:none!important}
  `;document.head.append(style);
  const attach=()=>{const panel=document.querySelector('[role=dialog][aria-label="'+title+'"]');if(panel){panel.dataset.officialPanel='true';return;}if(opened)return;const button=document.querySelector('button[aria-label="'+title+'"]');if(button){opened=true;button.click();}};
  new MutationObserver(attach).observe(document.body,{childList:true,subtree:true});attach();
  addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('[role=alertdialog],[role=listbox]'))event.stopImmediatePropagation();},{capture:true});
  addEventListener('click',event=>{const anchor=event.target.closest?.('a[href]');if(!anchor)return;const url=new URL(anchor.href,location.href);if(url.origin===location.origin&&url.pathname==='/watch'){event.preventDefault();event.stopImmediatePropagation();window.libreTVDesktop.call('official.navigate',{url:url.href}).catch(()=>{});}},{capture:true});
 };
 if(document.readyState==='loading')addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})();
