import { candidate, type SourceCandidate, type SourceKind } from './source-model';
interface Repository { full_name: string; html_url: string; default_branch?: string; }
type GitHub = (path: string, signal: AbortSignal) => Promise<unknown>;
const slugPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function repositorySlug(input: string): string | null {
  const text=input.trim().replace(/\.git\/?$/,'');
  if(slugPattern.test(text))return text;
  try { const url=new URL(text);if(url.hostname!=='github.com'&&url.hostname!=='www.github.com')return null;const parts=url.pathname.split('/').filter(Boolean);const slug=parts.slice(0,2).join('/').replace(/\.git$/,'');return parts.length>=2&&slugPattern.test(slug)?slug:null; } catch { return null; }
}
function normalizeFileURL(value:string):string {
  const url=new URL(value);
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.hostname==='github.com'&&parts[2]==='blob'&&parts.length>=5){url.hostname='raw.githubusercontent.com';url.pathname='/'+[...parts.slice(0,2),...parts.slice(3)].join('/');}
  url.hash='';return url.href;
}
function sourceKind(value:string):SourceKind|null {
  const url=new URL(value),pathname=url.pathname;
  if(/\/api\.php\/provide\/vod/i.test(pathname))return 'vod';
  if(/\.m3u8?$/i.test(pathname))return 'live';
  if(/\.json$/i.test(pathname)&&!/\/(?:package(?:-lock)?|tsconfig|manifest)\.json$/i.test(pathname))return 'subscription';
  return null;
}
export function extractCandidates(text:string,repo:Repository):SourceCandidate[]{
  const base=`https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch||'main'}/`;
  const links=[...(text.match(/https?:\/\/[^\s<>"'`\)\]\}]+/g)||[]),...Array.from(text.matchAll(/\]\(([^\s)]+)\)/g),match=>match[1])];
  return links.slice(0,10_000).flatMap(raw=>{
    try {const url=normalizeFileURL(new URL(raw.replace(/[,.，。;；]+$/,''),base).href),type=sourceKind(url);return type?[candidate(new URL(url).pathname.split('/').pop()||repo.full_name,url,type,repo.full_name,repo.html_url)]:[];} catch{return [];}
  });
}
export async function discoverSources(input:string,signal:AbortSignal,github:GitHub){
  const query=input.trim()||'LibreTV sources';
  try {
    const url=normalizeFileURL(query),type=sourceKind(url);
    if(type)return {candidates:[candidate(new URL(url).pathname.split('/').pop()||new URL(url).hostname,url,type,'输入地址')],repositories:[],note:'已识别直接接口或订阅地址，请检测后添加。'};
  } catch { /* Keywords and repository paths are handled below. */ }
  const slug=repositorySlug(query);
  const repos=slug?[await github(`/repos/${slug}`,signal) as Repository]:((await github('/search/repositories?'+new URLSearchParams({q:query,per_page:'5',sort:'updated'}),signal)) as {items?:Repository[]}).items||[];
  const found:SourceCandidate[]=[],repositories:{name:string;url:string}[]=[];
  await Promise.all(repos.map(async repo=>{
    if(!slugPattern.test(repo.full_name))return;
    repositories.push({name:repo.full_name,url:repo.html_url});
    const [readme,files]=await Promise.allSettled([github(`/repos/${repo.full_name}/readme`,signal),github(`/repos/${repo.full_name}/contents`,signal)]);
    if(readme.status==='fulfilled'){
      const value=readme.value as {encoding?:string;content?:string};
      if(value.encoding==='base64'&&value.content&&value.content.length<=700000)found.push(...extractCandidates(Buffer.from(value.content,'base64').toString('utf8'),repo));
    }
    if(files.status==='fulfilled'&&Array.isArray(files.value))for(const file of files.value.slice(0,1000)){
      if(file.type!=='file'||typeof file.download_url!=='string')continue;
      found.push(...extractCandidates(file.download_url,repo));
    }
  }));
  const unique=[...new Map(found.map(source=>[source.id,source])).values()];
  return {candidates:unique.slice(0,10_000),repositories,note:`已解析 ${repositories.length} 个 GitHub 仓库的 README 和根目录；${unique.length>10_000?`共 ${unique.length} 项，本次展示前 10000 项；`:""}候选尚未检测，不代表可以播放。`};
}
