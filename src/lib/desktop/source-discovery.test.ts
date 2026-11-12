import {describe,it,expect,vi} from 'vitest';
import {discoverSources,extractCandidates,repositorySlug} from './source-discovery';
const repo={full_name:'ljfbin2/tv-sources',html_url:'https://github.com/ljfbin2/tv-sources',default_branch:'main'};
const readme='## LibreTV 订阅地址\nhttps://raw.githubusercontent.com/ljfbin2/tv-sources/main/sources.json\n[其他配置](sources.json)\n[直播](echo-live.m3u)';
describe('source discovery repository and address inputs',()=>{
 it('resolves a pasted repository directly, without treating the URL as search keywords',async()=>{
  const github=vi.fn(async(path:string)=>{if(path==='/repos/ljfbin2/tv-sources')return repo;if(path.endsWith('/readme'))return {encoding:'base64',content:Buffer.from(readme).toString('base64')};if(path.endsWith('/contents'))return [{type:'file',download_url:'https://raw.githubusercontent.com/ljfbin2/tv-sources/main/sources.json'}];throw Error('Unexpected keyword search');});
  const result=await discoverSources(repo.html_url,new AbortController().signal,github);
  expect(result.candidates.map(source=>source.url)).toContain('https://raw.githubusercontent.com/ljfbin2/tv-sources/main/sources.json');
  expect(result.candidates.filter(source=>source.url.endsWith('/sources.json'))).toHaveLength(1);
  expect(github.mock.calls.some(([path])=>path.startsWith('/search/'))).toBe(false);
 });
 it('accepts shorthand, .git and branch URLs as repository inputs',()=>{
  for(const input of ['ljfbin2/tv-sources',repo.html_url,repo.html_url+'.git',repo.html_url+'/tree/main'])expect(repositorySlug(input)).toBe(repo.full_name);
 });
 it('normalizes GitHub file URLs and raw subscription addresses without repository search',async()=>{
  const github=vi.fn();
  for(const input of ['https://github.com/ljfbin2/tv-sources/blob/main/sources.json','https://raw.githubusercontent.com/ljfbin2/tv-sources/main/sources.json']){
   const result=await discoverSources(input,new AbortController().signal,github);expect(result.candidates[0].url).toBe('https://raw.githubusercontent.com/ljfbin2/tv-sources/main/sources.json');expect(result.candidates[0].type).toBe('subscription');
  }
  expect(github).not.toHaveBeenCalled();
 });
 it('extracts relative JSON and M3U links while excluding unrelated project metadata',()=>{
  const found=extractCandidates(readme+'\n[package](package.json)',repo);
  expect(found.some(source=>source.url.endsWith('/echo-live.m3u')&&source.type==='live')).toBe(true);
  expect(found.some(source=>source.url.endsWith('/package.json'))).toBe(false);
 });
});
