import {
  allLiveSources,
  keyBelongsToSubscription,
  subKeyPrefix,
  useAppStore,
} from "@/lib/store";
import type { SourceSearchOutcome } from "@/lib/types";
import { api } from "@/lib/client-api";
import { syncSourceSubscription } from "@/lib/subscription-sync";


import {
  candidate,
  type ProbeResult,
  type SourceCandidate,
} from "./source-model";
export * from "./source-model";
export function listAdded(): SourceCandidate[] {
  const state = useAppStore.getState();
  return [
    ...[...state.envSources, ...state.customAPIs].map((source) => ({
      ...candidate(source.name, source.url, "vod", "本机配置"),
      key: source.key,
      added: true,
      managed: state.envSources.some((s) => s.key === source.key)
        ? ("preset" as const)
        : state.subscriptions.some((sub) =>
              keyBelongsToSubscription(source.key, subKeyPrefix(sub.url)),
            )
          ? ("subscription" as const)
          : ("manual" as const),
    })),
    ...allLiveSources(state).map((source) => ({
      ...candidate(source.name, source.url, "live", "本机配置"),
      added: true,
      managed: state.liveEnvSources.some((s) => s.url === source.url)
        ? ("preset" as const)
        : state.liveSubscriptions.find((s) => s.url === source.url)
              ?.fromSubscriptions.length
          ? ("subscription" as const)
          : ("manual" as const),
    })),
    ...state.subscriptions.map((sub) => ({
      ...candidate(
        sub.name || new URL(sub.url).hostname,
        sub.url,
        "subscription",
        "本机订阅",
      ),
      added: true,
      managed: "manual" as const,
    })),
  ];
}
export async function addCandidate(source: SourceCandidate): Promise<string> {
  if (listAdded().some((existing) => existing.id === source.id))
    return "duplicate";
  const state = useAppStore.getState();
  if (source.type === "subscription") {
    const result = await syncSourceSubscription(source.url);
    return `导入 ${result.vodCount} 个点播源、${result.liveCount} 个直播源`;
  }
  if (source.type === "live")
    state.addLiveSubscription(source.url, source.name);
  else state.addCustomApi({ name: source.name, url: source.url });
  return "added";
}
export function removeCandidate(source: SourceCandidate): () => void {
  const state = useAppStore.getState();
  if (source.managed === "subscription")
    throw new Error("此源由订阅管理，请移除或停用对应订阅。");
  if (source.managed === "preset") {
    if (source.type === "vod") {
      const selected = state.selectedKeys.includes(source.key!);
      if (selected) state.toggleSourceSelected(source.key!);
      return () => {
        if (
          selected &&
          !useAppStore.getState().selectedKeys.includes(source.key!)
        )
          useAppStore.getState().toggleSourceSelected(source.key!);
      };
    }
    const selected = state.liveSelectedUrls.includes(source.url);
    if (selected) state.toggleLiveSelected(source.url);
    return () => {
      if (
        selected &&
        !useAppStore.getState().liveSelectedUrls.includes(source.url)
      )
        useAppStore.getState().toggleLiveSelected(source.url);
    };
  }
  if (source.type === "vod") {
    const snapshot = state.removeCustomApi(source.key!);
    return () => {
      if (snapshot) useAppStore.getState().restoreCustomApi(snapshot);
    };
  }
  if (source.type === "live") {
    const snapshot = state.removeLiveSubscription(source.url);
    return () => {
      if (snapshot) useAppStore.getState().restoreLiveSubscription(snapshot);
    };
  }
  const sub = state.subscriptions.find((s) => s.url === source.url);
  const vod = state.customAPIs.filter((s) =>
    keyBelongsToSubscription(s.key, subKeyPrefix(source.url)),
  );
  const live = state.liveSubscriptions.filter((s) =>
    s.fromSubscriptions.includes(source.url),
  );
  state.removeSubscription(source.url);
  return () => {
    const current = useAppStore.getState();
    if (current.subscriptions.some((s) => s.url === source.url)) return;
    current.addSubscription(source.url, sub?.name);
    current.applySubscriptionSources(source.url, vod);
    current.applySubscriptionLive(
      source.url,
      live.map((s) => ({ name: s.name || s.url, url: s.url, epg: s.epg })),
    );
    useAppStore.setState((s) => ({
      subscriptions: s.subscriptions.map((x) =>
        x.url === source.url && sub ? sub : x,
      ),
    }));
  };
}
/** Reuse official API results and health storage. Desktop code only schedules these calls. */
async function officialProbe(source: SourceCandidate, signal: AbortSignal, health: (source: SourceCandidate, result: {ok:boolean;ms?:number;error?:string}) => void): Promise<ProbeResult> {
  if (source.type === "subscription") {
    const payload = await api.fetchSourceList(source.url, signal);
    if (signal.aborted) throw new DOMException("已取消测活", "AbortError");
    const count = payload.sources.length + (payload.liveSources?.length ?? 0);
    return { state:"importable", count, message:`官方解析通过 · ${payload.sources.length} 点播 / ${payload.liveSources?.length ?? 0} 直播` };
  }
  const result = source.type === "live" ? await api.liveTest(source.url, signal) : await api.testSource(source.url, signal);
  if (signal.aborted) throw new DOMException("已取消测活", "AbortError");
  if (source.type === "vod") health(source,result);
  return {state:result.ok ? "ok" : "failed", ms:result.ms, count:result.count, message:result.ok ? `官方测活通过${result.count === undefined ? "" : ` · ${result.count} 条结果`}` : result.error || "官方测活失败"};
}
/** Snapshot source keys once, and batch official health writes for large queues. */
export function createProbeSession() {
  const keys = new Map<string,string[]>();
  for (const source of listAdded()) if (source.key) keys.set(source.id,[...(keys.get(source.id) ?? []),source.key]);
  let outcomes = new Map<string,SourceSearchOutcome>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer); timer = undefined;
    if (!outcomes.size) return;
    const batch = [...outcomes.values()]; outcomes = new Map();
    useAppStore.getState().recordSourceHealth(batch);
  };
  return {
    flush,
    probe: (source:SourceCandidate,signal:AbortSignal) => officialProbe(source,signal,(source,result) => {
      const matches = keys.get(source.id) ?? (source.key ? [source.key] : []);
      for (const key of matches) outcomes.set(key,{sourceKey:key,...result,list:[]});
      if (outcomes.size && !timer) timer = setTimeout(flush,150);
    }),
  };
}
export async function probeCandidate(source:SourceCandidate,signal:AbortSignal) {
  const session = createProbeSession();
  try { return await session.probe(source,signal); } finally { session.flush(); }
}
export function usable(result?: ProbeResult): boolean {
  return result?.state === "ok" || result?.state === "importable";
}

export { runProbeBatch, PROBE_CONCURRENCY } from "./probe-batch";
export { api };
