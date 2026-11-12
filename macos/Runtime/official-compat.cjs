'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
// A narrowly scoped response overlay for a verified official artifact. Never edits Core on disk.
const artifact = {
 version:'2.22.0', file:'/_next/static/chunks/354-fe055eb932927f43.js',
 sha256:'a8b9529b691a199de080ffdc66468ccda3c91ac8b2a1bd79d215a3fe04766e8d'
};
const edits = [
 ['await l.db.downloads.update(e,{...t,updatedAt:Date.now()}),S()','await l.db.constructor.ignoreTransaction(()=>l.db.downloads.update(e,{...t,updatedAt:Date.now()})),S()'],
 ['let a=0;N({taskId:e.id','let a=0,persist=(globalThis.__ltNativePromise||Promise).resolve();N({taskId:e.id'],
 ['a=n,l.db.downloads.update(e.id,{finished:t.current,total:t.total,status:r,updatedAt:n}))','a=n,persist=persist.then(()=>l.db.constructor.ignoreTransaction(()=>l.db.downloads.update(e.id,{finished:t.current,total:t.total,status:r,updatedAt:n}))))'],
 ['keepOriginalTimestamps:!0','keepOriginalTimestamps:!1'],
 ['"trak"===e&&p(n,t,i,(e,t,i)=>{"tkhd"===e&&0===n[t]&&t+24<=i&&m(n,t+20,r)})','"trak"===e&&p(n,t,i,(e,t,i)=>{if("tkhd"===e&&0===n[t]&&t+24<=i)m(n,t+20,r);if("mdia"===e)p(n,t,i,(e,t,i)=>{"mdhd"===e&&0===n[t]&&t+20<=i&&m(n,t+16,0)})})'],
 ['await d.waitIfPaused();let e=++C;', 'await d.waitIfPaused();if(C>=N||b.aborted)return;let e=++C;'],
 ['let t=x.current.get(e.id);if(t&&"downloading"===e.status)', 'let t=x.current.get(e.id);if(t&&"paused"===e.status){t.pause.resume();await k(e.id,{status:"downloading"});return}if(t&&"downloading"===e.status)'],
 ['globalThis.__dlSaveTarget={id:n,target:e}', 'globalThis.__dlSaveTarget={id:n,target:e};globalThis.__ltDownloadTargets.set(n,{id:n,target:e})'],
 ['globalThis.__dlSaveTarget={id:e.id,target:t}', 'globalThis.__dlSaveTarget={id:e.id,target:t},globalThis.__ltDownloadTargets.set(e.id,{id:e.id,target:t})'],
 ['target:(null==(r=globalThis.__dlSaveTarget)?void 0:r.id)===e.id?globalThis.__dlSaveTarget.target:', 'target:globalThis.__ltDownloadTargets.has(e.id)?globalThis.__ltDownloadTargets.get(e.id).target:'],
 ['"waiting"===e.status&&!x.current.has(e.id)', '"waiting"===e.status&&globalThis.__ltDownloadTargets.has(e.id)&&!x.current.has(e.id)'],
 ['.then(async()=>{await k(e.id,{status:"completed"})', '.then(async()=>{await persist;if(n.signal.aborted)return;await k(e.id,{status:"completed"})'],
 ['.finally(()=>{x.current.delete(e.id),E()})', '.finally(()=>{globalThis.__ltDownloadTargets.get(e.id)?.target.abort();globalThis.__ltDownloadTargets.delete(e.id);x.current.delete(e.id),E()})'],
 ['null==(t=x.current.get(e.id))||t.abort.abort(),x.current.delete(e.id)', 'null==(t=x.current.get(e.id))||t.abort.abort(),t?.pause.destroy(),await globalThis.__ltDownloadTargets.get(e.id)?.target.abort(),globalThis.__ltDownloadTargets.delete(e.id),x.current.delete(e.id)'],
 ['let r="done"===t.status?"completed":"error"===t.status?"error":"downloading"', 'let r="done"===t.status?"completed":"error"===t.status?"error":i.getPaused()?"paused":"downloading"']
];
function patch(source) {
 if(createHash('sha256').update(source).digest('hex')!==artifact.sha256)throw new Error('Official download artifact differs; compatibility overlay not applied');
 for(const [before,after] of edits){if(source.split(before).length!==2)throw new Error('Compatibility edit is not unique');source=source.replace(before,after);}
 return ';globalThis.__ltDownloadTargets??=new Map;'+source;
}
const settingsArtifact = {"file": "/_next/static/chunks/312-532e92dc3e2bcf7f.js", "sha256": "4dcf2957980a6361ce1abdb6f45d06cb074bf8a6930ebbaa66c665504bd8c32a"};
const layoutArtifact = {file:'/_next/static/chunks/app/layout-45a4982cfa62ca6c.js',sha256:'afb2e8e12b8d5cc8959d772031a160d448661937fd884a4760bb1980ee728770'};
function patchSystemLabel(source) {
 const before='"跟随系统（当前深色）"',after='"跟随系统（当前"+("dark"===t?"深色":"浅色")+"）"';
 if(source.split(before).length!==2)throw new Error('Theme label compatibility edit is not unique');
 return source.replace(before,after);
}
function patchSettings(source) {
 if(createHash('sha256').update(source).digest('hex')!==settingsArtifact.sha256)throw new Error('Official settings artifact differs; persistence overlay not applied');
 const before="let[e,t]=(0,r.useState)(null),s=(0,r.useRef)(0);(0,r.useEffect)(()=>()=>{s.current++},[]);let n=(0,r.useCallback)(()=>{s.current++,t(null)},[]);return{progress:e,probe:",after="let shared=globalThis.__ltOfficialVodProbe??={progress:null,ref:{current:0},listeners:new Set};let[e,local]=(0,r.useState)(shared.progress),s=shared.ref,t=e=>{shared.progress=e;for(let listener of shared.listeners)listener(e)};(0,r.useEffect)(()=>{shared.listeners.add(local);local(shared.progress);return()=>shared.listeners.delete(local)},[]);let n=(0,r.useCallback)(()=>{s.current++;globalThis.__ltCancelOfficialProbes?.();t(null)},[]);return{progress:e,probe:";
 if(source.split(before).length!==2)throw new Error('Settings compatibility edit is not unique');
 const themeBefore="return t.addEventListener(\"change\",s),()=>t.removeEventListener(\"change\",s)},[]);let u=(0,l.useCallback)",themeAfter="let sync=e=>{if(\"storage\"===e.type&&e.key!==a)return;let t=localStorage.getItem(a)||\"dark\";[\"light\",\"dark\",\"system\"].includes(t)&&(c(t),d(i(t)))};return t.addEventListener(\"change\",s),window.addEventListener(\"storage\",sync),window.addEventListener(\"libretv:desktop-theme\",sync),()=>{t.removeEventListener(\"change\",s),window.removeEventListener(\"storage\",sync),window.removeEventListener(\"libretv:desktop-theme\",sync)}},[]);let u=(0,l.useCallback)";
 if(source.split(themeBefore).length!==2)throw new Error("Theme compatibility edit is not unique");
 return patchSystemLabel(source.replace(before,after).replace(themeBefore,themeAfter));
}
function patchLayout(source) {
 if(createHash('sha256').update(source).digest('hex')!==layoutArtifact.sha256)throw new Error('Official layout artifact differs; theme overlay not applied');
 const before='return t.addEventListener("change",r),()=>t.removeEventListener("change",r)},[]);let h=(0,n.useCallback)',after='let sync=e=>{if("storage"===e.type&&e.key!==o)return;let t=localStorage.getItem(o)||"dark";["light","dark","system"].includes(t)&&(i(t),d(l(t)))};return t.addEventListener("change",r),window.addEventListener("storage",sync),window.addEventListener("libretv:desktop-theme",sync),()=>{t.removeEventListener("change",r),window.removeEventListener("storage",sync),window.removeEventListener("libretv:desktop-theme",sync)}},[]);let h=(0,n.useCallback)';
 if(source.split(before).length!==2)throw new Error('Layout theme compatibility edit is not unique');
 return patchSystemLabel(source.replace(before,after));
}
function load(core) {
 const version=JSON.parse(fs.readFileSync(path.join(core,'package.json'),'utf8')).version;
 const required=new Set(['libretv-video-v1','libretv-dl-v1','showSaveFilePicker','libretv:add-download','libretv:show-download-manager','libretv-settings']);
 const chunks=path.join(core,'.next/static/chunks');
 for(const file of fs.readdirSync(chunks,{recursive:true})){if(!file.endsWith('.js'))continue;const code=fs.readFileSync(path.join(chunks,file),'utf8');for(const capability of required)if(code.includes(capability))required.delete(capability);if(!required.size)break;}
 if(required.size)throw new Error('Official browser API contract changed: '+[...required].join(', '));
 if(version!==artifact.version)return null;
 const source=fs.readFileSync(path.join(core,'.next',artifact.file.replace('/_next/','')),'utf8');
 const settings=fs.readFileSync(path.join(core,'.next',settingsArtifact.file.replace('/_next/','')),'utf8');
 const layout=fs.readFileSync(path.join(core,'.next',layoutArtifact.file.replace('/_next/','')),'utf8');
 return {path:artifact.file,body:patch(source),additional:[{path:settingsArtifact.file,body:patchSettings(settings)},{path:layoutArtifact.file,body:patchLayout(layout)}],id:'official-2.22.0-desktop-compat-v7'};
}
module.exports={artifact,settingsArtifact,layoutArtifact,patch,patchSettings,patchLayout,load};
