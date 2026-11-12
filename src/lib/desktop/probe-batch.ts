import { normalizedURL, type SourceCandidate, type ProbeResult } from './source-model';

export const PROBE_CONCURRENCY = 32;
export const PROBE_PER_HOST = 3;
export const PROBE_TIMEOUT_MS = 8_000;
export const PROBE_TAIL_MS = 2_500;

export class ProbeControl {
  paused = false;
  private listeners = new Set<() => void>();
  setPaused(value: boolean) {
    this.paused = value;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
export interface ProbeProgress {
  total: number; done: number; active: number; queued: number; paused: boolean;
}
interface Options {
  concurrency?: number; perHost?: number; tailMs?: number; tailCount?: number;
  control?: ProbeControl; onProgress?: (progress: ProbeProgress) => void;
}
/** A bounded, host-fair pool; only scheduling lives here. Availability comes from official APIs. */
export async function runProbeBatch(
  sources: SourceCandidate[], parent: AbortSignal,
  onResult: (id: string, result: ProbeResult) => void,
  probe: (source: SourceCandidate, signal: AbortSignal) => Promise<ProbeResult>,
  timeoutMs = PROBE_TIMEOUT_MS, options: Options = {},
): Promise<void> {
  if (parent.aborted) return;
  const concurrency = Math.max(1, Math.min(64, Math.floor(options.concurrency ?? PROBE_CONCURRENCY)));
  const perHost = Math.max(1, Math.min(concurrency, Math.floor(options.perHost ?? PROBE_PER_HOST)));
  const tailCount = options.tailCount ?? 2, tailMs = options.tailMs ?? PROBE_TAIL_MS;
  const unique = new Map<string, SourceCandidate>();
  for (const source of sources) unique.set(`${source.type}:${normalizedURL(source.url)}`, source);
  const hosts = new Map<string, { items: SourceCandidate[]; cursor: number; active: number }>();
  for (const source of unique.values()) {
    const host = new URL(source.url).hostname;
    if (!hosts.has(host)) hosts.set(host, { items: [], cursor: 0, active: 0 });
    hosts.get(host)!.items.push(source);
    onResult(source.id, { state: 'queued', message: '排队中' });
  }
  const groups = [...hosts.values()];
  const active = new Set<{ controller: AbortController; abandoned: boolean }>();
  const total = unique.size;
  let done = 0, dispatched = 0, nextHost = 0, settled = false;
  let tailTimer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => options.onProgress?.({ total, done, active: active.size, queued: total - dispatched, paused: options.control?.paused ?? false });
  await new Promise<void>((resolve) => {
    const clearTail = () => { if (tailTimer) clearTimeout(tailTimer); tailTimer = undefined; };
    const finish = () => { if (settled) return; settled = true; clearTail(); parent.removeEventListener('abort', abort); unsubscribe?.(); progress(); resolve(); };
    const abort = () => { clearTail(); for (const task of active) task.controller.abort(); if (!active.size) finish(); };
    const armTail = () => {
      if (tailTimer || options.control?.paused || parent.aborted || total <= concurrency || dispatched < total || !active.size || active.size > tailCount) return;
      tailTimer = setTimeout(() => { for (const task of active) { task.abandoned = true; task.controller.abort(); } }, tailMs);
    };
    const execute = async (source: SourceCandidate, group: typeof groups[number]) => {
      const controller = new AbortController(), task = { controller, abandoned: false };
      active.add(task); group.active++; dispatched++;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let rejectAbort = () => {};
      try {
        onResult(source.id, { state: 'testing', message: '正在调用官方测活' });
        const interrupted = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(new DOMException('已中止', 'AbortError'));
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
          if (controller.signal.aborted) rejectAbort();
        });
        const result = await Promise.race([Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new DOMException('已中止','AbortError');
          return probe(source, controller.signal);
        }), interrupted]);
        if (!parent.aborted) onResult(source.id, result);
      } catch (error) {
        if (!parent.aborted) onResult(source.id, {
          state: task.abandoned ? 'abandoned' : timedOut ? 'timeout' : 'failed',
          message: task.abandoned ? '收尾已放弃；可单独重试' : timedOut ? `等待超过 ${timeoutMs / 1000} 秒，已放弃；未改动官方健康记录` : (error as Error).message,
        });
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort);
        active.delete(task); group.active--; done++;
        pump();
      }
    };
    const pump = () => {
      if (settled) return;
      if (parent.aborted) { if (!active.size) finish(); return; }
      if (options.control?.paused) clearTail();
      else {
        let misses = 0;
        while (!parent.aborted && active.size < concurrency && dispatched < total && misses < groups.length) {
          const group = groups[nextHost++ % groups.length];
          if (group.active >= perHost || group.cursor >= group.items.length) { misses++; continue; }
          misses = 0;
          void execute(group.items[group.cursor++], group);
        }
      }
      progress();
      if (done === total) finish(); else armTail();
    };
    const unsubscribe = options.control?.subscribe(pump);
    parent.addEventListener('abort', abort, { once: true });
    pump();
  });
}
