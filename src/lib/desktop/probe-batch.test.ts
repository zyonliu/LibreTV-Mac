import { describe, expect, it } from "vitest";
import { ProbeControl, runProbeBatch } from "./probe-batch";
import { candidate, normalizedURL, type ProbeResult } from "./source-model";
const sources = Array.from({ length: 8 }, (_, i) =>
  candidate(`source-${i}`, `https://example.test/${i}`, "vod"),
);
describe("desktop source probes", () => {
  it("normalizes equivalent URLs and rejects credentials and non-http protocols", () => {
    expect(normalizedURL(" https://EXAMPLE.test:443/api/#a ")).toBe(
      "https://example.test/api",
    );
    expect(() => normalizedURL("file:///tmp/a")).toThrow();
    expect(() => normalizedURL("https://user:pass@example.test")).toThrow();
  });
  it("bounds concurrency to three, keeps result order by ID, and isolates individual failure", async () => {
    let active = 0,
      max = 0;
    const results: Record<string, ProbeResult> = {};
    await runProbeBatch(
      sources,
      new AbortController().signal,
      (id, result) => {
        results[id] = result;
      },
      async (source) => {
        active++;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active--;
        if (source.name === "source-2") throw new Error("unavailable");
        return { state: "ok", message: "sample reachable" };
      },
      1000,
      {concurrency:3},
    );
    expect(max).toBe(3);
    expect(results[sources[2].id].state).toBe("failed");
    expect(Object.values(results).filter((r) => r.state === "ok")).toHaveLength(
      7,
    );
  });
  it("aborts in-flight requests and prevents late results from replacing a newer run", async () => {
    const controller = new AbortController(),
      results: ProbeResult[] = [];
    let started = 0;
    await runProbeBatch(
      sources,
      controller.signal,
      (_, result) => {
        results.push(result);
      },
      async (_, signal) => {
        started++;
        controller.abort();
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        return { state: "ok", message: "late" };
      },
    );
    expect(started).toBe(1);
    expect(results.some((result) => result.state === "ok")).toBe(false);
  });
  it("reports a real per-request timeout", async () => {
    let result: ProbeResult | undefined;
    await runProbeBatch(
      sources.slice(0, 1),
      new AbortController().signal,
      (_, value) => {
        result = value;
      },
      async (_, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          ),
        ),
      5,
    );
    expect(result?.state).toBe("timeout");
  });
});

describe('large queues', () => {
  it('finishes 10,000 unique jobs with 32 actual active probes and no duplicate request', async () => {
    const items = Array.from({length:10_000}, (_, i) => candidate(`s${i}`, `https://h${i % 100}.test/${i}`, 'vod'));
    let active = 0, peak = 0, calls = 0;
    const hosts = new Map<string, number>();
    let hostPeak = 0;
    await runProbeBatch([...items, ...items.slice(0, 100)], new AbortController().signal, () => {}, async source => {
      calls++; active++; peak = Math.max(peak, active);
      const host = new URL(source.url).hostname;
      hosts.set(host, (hosts.get(host) ?? 0) + 1); hostPeak = Math.max(hostPeak, hosts.get(host)!);
      await new Promise(resolve => setTimeout(resolve, 0));
      active--; hosts.set(host, hosts.get(host)! - 1);
      return {state:'ok',message:'official fixture'};
    });
    expect(calls).toBe(10_000); expect(peak).toBe(32); expect(hostPeak).toBeLessThanOrEqual(3); expect(active).toBe(0);
  });
  it('does not let a slow host block another host and refills a vacant slot immediately', async () => {
    const items = [candidate('slow1','https://slow.test/1','vod'), candidate('slow2','https://slow.test/2','vod'), candidate('fast','https://fast.test/1','vod')];
    const started: string[] = []; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const job = runProbeBatch(items,new AbortController().signal,()=>{},async source => {
      started.push(source.name); if(source.name==='slow1') await blocked;
      return {state:'ok',message:'ok'};
    },1000,{concurrency:2,perHost:1});
    await new Promise(resolve=>setTimeout(resolve,5));
    expect(started).toEqual(['slow1','fast']); release(); await job;
    expect(started).toEqual(['slow1','fast','slow2']);
  });
  it('releases a slot even when the underlying promise ignores cancellation', async () => {
    let result: ProbeResult | undefined;
    await runProbeBatch(sources.slice(0,1),new AbortController().signal,(_,r)=>{result=r;},()=>new Promise(()=>{}),5);
    expect(result?.state).toBe('timeout');
  });
  it('abandons only the last slow jobs, without retrying successful ones', async () => {
    const results = new Map<string,ProbeResult>();
    await runProbeBatch(sources,new AbortController().signal,(id,r)=>results.set(id,r),async source=>{
      if(source===sources[7])return new Promise(()=>{});
      return {state:'ok',message:'ok'};
    },1000,{concurrency:3,tailMs:5});
    expect([...results.values()].filter(r=>r.state==='ok')).toHaveLength(7);
    expect(results.get(sources[7].id)?.state).toBe('abandoned');
  });
});

it('pauses dispatch, keeps in-flight results, then resumes only remaining work', async () => {
  const control = new ProbeControl();
  const started: string[] = [], results = new Map<string,ProbeResult>();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const job = runProbeBatch(sources,new AbortController().signal,(id,r)=>results.set(id,r),async source=>{
    started.push(source.id); if(started.length===1)await blocked;
    return {state:'ok',message:'ok'};
  },1000,{concurrency:1,control});
  control.setPaused(true); release();
  await new Promise(resolve=>setTimeout(resolve,5));
  expect(started).toHaveLength(1); expect(results.get(sources[0].id)?.state).toBe('ok');
  control.setPaused(false); await job;
  expect(new Set(started).size).toBe(8); expect([...results.values()].every(r=>r.state==='ok')).toBe(true);
});
