import { NextResponse } from 'next/server';
import { guardDesktopRequest } from '@/lib/desktop/api-guard';
import { discoverSources } from '@/lib/desktop/source-discovery';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function github(path:string,signal:AbortSignal):Promise<unknown>{
 const response=await fetch('https://api.github.com'+path,{headers:{Accept:'application/vnd.github+json','User-Agent':'LibreTV-Mac-local'},signal,cache:'no-store'});
 if(!response.ok)throw new Error(`GitHub 返回 ${response.status}，请稍后重试或粘贴订阅直链。`);
 return response.json();
}
export async function GET(req:Request){
 const denied=guardDesktopRequest(req);if(denied)return denied;
 const query=(new URL(req.url).searchParams.get('q')||'LibreTV sources').slice(0,2048);
 try{return NextResponse.json(await discoverSources(query,AbortSignal.any([req.signal,AbortSignal.timeout(15000)]),github));}
 catch(error){return NextResponse.json({error:(error as Error).message},{status:502});}
}
