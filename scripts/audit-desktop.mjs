#!/usr/bin/env node
// Audits only desktop-owned dependencies/runtime. Mutable official Core is excluded.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const options=process.argv.slice(2);
function argument(name,fallback){const i=options.indexOf(name);return i<0?fallback:options[i+1];}
const output=path.resolve(argument('--output',path.join(root,'build/security-audit/final')));
const bundle=argument('--bundle');
const configuration=JSON.parse(await readFile(path.join(root,'scripts/runtime-config.json'),'utf8'));
const runtime=path.join(root,`build/runtime/node-v${configuration.nodeVersion}-darwin-arm64`);
const npm=path.join(runtime,'lib/node_modules/npm/bin/npm-cli.js');
const semver=createRequire(npm)('semver');
await mkdir(output,{recursive:true});
const save=async(name,value)=>writeFile(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const scope={included:['desktop project production dependencies','desktop project development dependencies','shipped Desktop dependencies when --bundle is supplied','bundled Node runtime for darwin'],excluded:['Contents/Resources/Core','user-selected or future official LibreTV cores']};
function execute(executable,args){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd:root,env:{...process.env,PATH:path.join(runtime,'bin')+':/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Audit subprocess timed out'));},120000);
  child.stdout.on('data',value=>{stdout+=value;if(stdout.length>16*1024*1024){child.kill('SIGTERM');reject(new Error('Audit output exceeds limit'));}});
  child.stderr.on('data',value=>{stderr+=value;});child.once('error',reject);
  child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
}
async function projectAudit(production){
 const result=await execute(process.execPath,[npm,'audit','--json','--fetch-retries=1','--fetch-timeout=20000',...(production?['--omit=dev']:[])]);
 const data=JSON.parse(result.stdout);await save(production?'npm-production.json':'npm-all.json',data);
 assert.equal(typeof data.metadata?.vulnerabilities?.total,'number','npm audit returned no valid vulnerability result');
 assert.equal(result.code,0,`npm audit still reports ${data.metadata.vulnerabilities.total} vulnerable packages`);
 assert.equal(data.metadata.vulnerabilities.total,0,'Vulnerable desktop dependency remains');
 return {vulnerabilities:data.metadata.vulnerabilities,dependencies:data.metadata.dependencies};
}
async function fetchJSON(url,init){
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,200,`Security source failed: ${url}`);
 const text=await response.text();assert.ok(text.length<8*1024*1024,'Security response exceeds limit');
 return JSON.parse(text);
}
async function inventory(directory){
 const entries=[],unversioned=[];const boundary=await realpath(directory);
 async function walk(folder){
  for(const entry of await readdir(folder,{withFileTypes:true})){
   const file=path.join(folder,entry.name);
   if(entry.isSymbolicLink()){
    const target=await realpath(file);assert.ok(target===boundary||target.startsWith(boundary+path.sep),'External dependency symlink');continue;
   }
   if(entry.isDirectory())await walk(file);
   else if(entry.name==='package.json'){
    const pkg=JSON.parse(await readFile(file,'utf8')),relative=path.relative(directory,file);
    if(pkg.name&&semver.valid(pkg.version))entries.push({name:pkg.name,version:pkg.version,path:relative});
    else unversioned.push(relative);
   }
  }
 }
 await walk(directory);assert.ok(entries.length>0,'No shipped dependency metadata found');return {entries,unversioned};
}
async function runtimeAudit(node){
 const result=await execute(node,['-p','JSON.stringify(process.versions)']);assert.equal(result.code,0);
 const versions=JSON.parse(result.stdout);assert.equal(versions.node,configuration.nodeVersion,'Stale bundled Node runtime');
 const databaseURL='https://raw.githubusercontent.com/nodejs/security-wg/main/vuln/core/index.json';
 const scheduleURL='https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
 const [database,schedule]=await Promise.all([fetchJSON(databaseURL),fetchJSON(scheduleURL)]);
 assert.ok(Object.keys(database).length>100,'Incomplete Node security database');
 const matches=[];
 for(const [id,item] of Object.entries(database)){
  assert.equal(typeof item.vulnerable,'string','Invalid Node vulnerability version range');assert.equal(typeof item.patched,'string','Invalid Node patched version range');
  const affected=!Array.isArray(item.affectedEnvironments)||item.affectedEnvironments.some(platform=>platform==='all'||platform==='darwin');
  if(affected&&semver.satisfies(versions.node,item.vulnerable)&&!semver.satisfies(versions.node,item.patched))matches.push({id,cve:item.cve,severity:item.severity,patched:item.patched});
 }
 const release=schedule['v'+versions.node.split('.')[0]];assert.ok(release&&Date.now()<Date.parse(release.end),'Node runtime is end-of-life');
 await save('node-security-database.json',database);await save('node-release-schedule.json',schedule);
 const report={version:versions.node,embeddedUndici:versions.undici,platform:'darwin',matches,endOfLife:release.end,sources:[databaseURL,scheduleURL]};
 await save('node-runtime.json',report);assert.equal(matches.length,0,'Bundled Node matches a published vulnerability');return {report,versions};
}
try{
 const node=bundle?path.join(path.resolve(bundle),'Contents/Resources/Runtime/node'):path.join(runtime,'bin/node');
 const [all,production,nodeResult]=await Promise.all([projectAudit(false),projectAudit(true),runtimeAudit(node)]);
 let shipped={status:'not requested'};
 if(bundle){
  const shippedLock=await readFile(path.join(path.resolve(bundle),'Contents/Resources/Desktop/desktop-package-lock.json'));
  assert.deepEqual(shippedLock,await readFile(path.join(root,'package-lock.json')),'Bundle was built with a different dependency lockfile');
  // This is intentionally the separate Desktop tree, never the mutable official Core.
  const {entries,unversioned}=await inventory(path.join(path.resolve(bundle),'Contents/Resources/Desktop/node_modules'));
  const query={};for(const item of entries){query[item.name]??=[];if(!query[item.name].includes(item.version))query[item.name].push(item.version);}
  if(nodeResult.versions.undici){query.undici??=[];if(!query.undici.includes(nodeResult.versions.undici))query.undici.push(nodeResult.versions.undici);}
  // Positive control prevents an empty/proxy/error response being accepted as a clean scan.
  query.undici??=[];if(!query.undici.includes('6.21.1'))query.undici.push('6.21.1');
  const url='https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
  const advisories=await fetchJSON(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(query)});
  assert.ok(advisories&&typeof advisories==='object'&&!Array.isArray(advisories),'Invalid npm advisory response');
  const control=(advisories.undici||[]).some(row=>semver.satisfies('6.21.1',row.vulnerable_versions,{includePrerelease:true}));
  assert.ok(control,'Advisory service failed the known-vulnerable positive control');
  const actual=[...entries,...(nodeResult.versions.undici?[{name:'undici',version:nodeResult.versions.undici,path:'Node embedded fetch implementation'}]:[])];
  const matches=actual.flatMap(item=>(advisories[item.name]||[]).filter(row=>semver.satisfies(item.version,row.vulnerable_versions,{includePrerelease:true})).map(row=>({...item,title:row.title,severity:row.severity,url:row.url,range:row.vulnerable_versions})));
  shipped={status:'passed',versionedPackages:entries.length,unversionedMetadata:unversioned.length,matches,positiveControl:{package:'undici',version:'6.21.1',detected:true,shipped:false},source:url};
  await save('shipped-desktop-inventory.json',{entries,unversioned,coverage:'Versioned package metadata plus npm project lockfile; upstream framework-internal code is covered by its framework package advisories.'});
  await save('shipped-advisory-query.json',query);await save('shipped-advisory-response.json',advisories);await save('shipped-desktop-audit.json',shipped);
  assert.equal(matches.length,0,'Shipped Desktop/Node dependency still matches an advisory');
 }
 const lock=await readFile(path.join(root,'package-lock.json'));
 const {createHash}=await import('node:crypto');
 const summary={status:'passed',checkedAt:new Date().toISOString(),scope,packageLockSHA256:createHash('sha256').update(lock).digest('hex'),projectAll:all,projectProduction:production,nodeRuntime:nodeResult.report,shippedDesktop:shipped};
 await save('summary.json',summary);console.log(JSON.stringify({status:summary.status,allVulnerable:0,productionVulnerable:0,shippedStatus:shipped.status,node:nodeResult.report.version,officialCore:'excluded'},null,2));
}catch(error){
 await save('summary.json',{status:'failed',checkedAt:new Date().toISOString(),scope,error:error.message});console.error(error.message);process.exitCode=1;
}
