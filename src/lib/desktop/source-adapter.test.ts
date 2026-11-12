import {beforeEach,describe,expect,it,vi} from 'vitest';
const fixture = vi.hoisted(()=>({
  testSource:vi.fn(), liveTest:vi.fn(), fetchSourceList:vi.fn(), recordSourceHealth:vi.fn(),
  sources:[{key:'first',name:'A',url:'https://fixture.test/api'},{key:'duplicate',name:'B',url:'https://fixture.test/api'}],
}));
vi.mock('@/lib/client-api',()=>({api:fixture}));
vi.mock('@/lib/subscription-sync',()=>({syncSourceSubscription:vi.fn()}));
vi.mock('@/lib/store',()=>({
  useAppStore:{getState:()=>({envSources:[],customAPIs:fixture.sources,subscriptions:[],liveSubscriptions:[],liveEnvSources:[],recordSourceHealth:fixture.recordSourceHealth})},
  allLiveSources:()=>[],keyBelongsToSubscription:()=>false,subKeyPrefix:()=>'',
}));
import {candidate,createProbeSession} from './source-adapter';
beforeEach(()=>{vi.clearAllMocks();});
describe('official source probe adapter',()=>{
  it('uses exactly the official result and writes every matching official key in one batch',async()=>{
    fixture.testSource.mockResolvedValue({ok:true,ms:123,count:0});
    const session=createProbeSession(), signal=new AbortController().signal;
    expect(await session.probe(candidate('A','https://fixture.test/api','vod'),signal)).toMatchObject({state:'ok',ms:123,count:0});
    expect(fixture.testSource).toHaveBeenCalledOnce();expect(fixture.testSource).toHaveBeenCalledWith('https://fixture.test/api',signal);
    expect(fixture.recordSourceHealth).not.toHaveBeenCalled();session.flush();
    expect(fixture.recordSourceHealth).toHaveBeenCalledOnce();
    expect(fixture.recordSourceHealth.mock.calls[0][0].map((row:{sourceKey:string})=>row.sourceKey)).toEqual(['first','duplicate']);
    expect(fixture.liveTest).not.toHaveBeenCalled();expect(fixture.fetchSourceList).not.toHaveBeenCalled();
  });
  it('does not turn a late cancelled response into an official health failure',async()=>{
    const controller=new AbortController();
    fixture.testSource.mockImplementation(async()=>{controller.abort();return {ok:false,error:'late'};});
    const session=createProbeSession();await expect(session.probe(candidate('A','https://fixture.test/api','vod'),controller.signal)).rejects.toThrow();
    session.flush();expect(fixture.recordSourceHealth).not.toHaveBeenCalled();
  });
  it('delegates live and subscription parsing without adding another reachability or content rule',async()=>{
    fixture.liveTest.mockResolvedValue({ok:true,ms:40,count:10});fixture.fetchSourceList.mockResolvedValue({sources:[],liveSources:[]});
    const session=createProbeSession(), signal=new AbortController().signal;
    expect(await session.probe(candidate('L','https://live.test/list.m3u','live'),signal)).toMatchObject({state:'ok',count:10});
    expect(await session.probe(candidate('S','https://sub.test/sources.json','subscription'),signal)).toMatchObject({state:'importable',count:0});
    session.flush();expect(fixture.recordSourceHealth).not.toHaveBeenCalled();expect(fixture.testSource).not.toHaveBeenCalled();
  });
});
