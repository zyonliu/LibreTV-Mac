"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import {
  addCandidate,
  candidate,
  listAdded,
  removeCandidate,
  createProbeSession,
  runProbeBatch,
  PROBE_CONCURRENCY,
  usable,
  type SourceCandidate,
  type SourceKind,
  type ProbeResult,
} from "@/lib/desktop/source-adapter";
import { ProbeControl, type ProbeProgress } from "@/lib/desktop/probe-batch";
import { useToast } from "@/components/toast";
import { Empty, SelectAll } from "./controls";
import { Search, X } from "lucide-react";
import { FilterSelect } from "./filter-select";

export function DesktopSources() {
  const customAPIs = useAppStore((s) => s.customAPIs),
    envSources = useAppStore((s) => s.envSources),
    subscriptions = useAppStore((s) => s.subscriptions),
    liveSubscriptions = useAppStore((s) => s.liveSubscriptions),
    liveEnvSources = useAppStore((s) => s.liveEnvSources);
  const added = useMemo(() => {
    void [
      customAPIs,
      envSources,
      subscriptions,
      liveSubscriptions,
      liveEnvSources,
    ];
    return listAdded();
  }, [
    customAPIs,
    envSources,
    subscriptions,
    liveSubscriptions,
    liveEnvSources,
  ]);
  const [view, setView] = useState("found"),
    [query, setQuery] = useState(""),
    [range, setRange] = useState("github"),
    [type, setType] = useState("all"),
    [healthy, setHealthy] = useState(false);
  const [found, setFound] = useState<SourceCandidate[]>([]),
    [selected, setSelected] = useState(new Set<string>()),
    [results, setResults] = useState<Record<string, ProbeResult>>({});
  const [discoverQuery, setDiscoverQuery] = useState(""),
    [discovering, setDiscovering] = useState(false),
    [repositories, setRepositories] = useState<{ name: string; url: string }[]>(
      [],
    ),
    [notice, setNotice] = useState("");
  const [manualURL, setManualURL] = useState(""),
    [manualName, setManualName] = useState(""),
    [manualType, setManualType] = useState<SourceKind>("subscription"),
    [busy, setBusy] = useState(false),
    [probing, setProbing] = useState(false);
  const run = useRef<AbortController | null>(null),
    discoverRun = useRef<AbortController | null>(null),
    generation = useRef(0),
    previous = useRef<Record<string, ProbeResult>>({});
  const flushRun = useRef(() => {});
  const control = useRef(new ProbeControl());
  const [progress, setProgress] = useState<ProbeProgress | null>(null);
  const [paused, setPaused] = useState(false);
  const [page, setPage] = useState(0);
  const { toast } = useToast();
  useEffect(() => {
    const stop = () => { run.current?.abort(); discoverRun.current?.abort(); };
    window.addEventListener("pagehide", stop);
    window.addEventListener("libretv:desktop-terminate", stop);
    try {
      setFound(
        JSON.parse(sessionStorage.getItem("desktop-candidates") || "[]"),
      );
    } catch {
      /* empty session */
    }
    return () => {
      stop();
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("libretv:desktop-terminate", stop);
    };
  }, []);
  const saveFound = (sources: SourceCandidate[]) => {
    setFound(sources);
    sessionStorage.setItem("desktop-candidates", JSON.stringify(sources));
  };
  const addedIDs = useMemo(() => new Set(added.map(source => source.id)), [added]);
  const discovered = useMemo(
    () => found.filter(source => !addedIDs.has(source.id)),
    [found, addedIDs],
  );
  const visible = useMemo(
    () =>
      (view === "added" ? added : discovered).filter(
        (source) =>
          (type === "all" || source.type === type) &&
          (view === "found" || `${source.name} ${source.url} ${source.origin}`
            .toLowerCase()
            .includes(query.toLowerCase())) &&
          (!healthy || usable(results[source.id])),
      ),
    [view, added, discovered, type, query, healthy, results],
  );
  const pageSize = 100, pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selectedRows = visible.filter((source) => selected.has(source.id));
  const addable = selectedRows.filter(
    (source) =>
      usable(results[source.id]) && !addedIDs.has(source.id),
  );
  const removable = selectedRows.filter(
    (source) => source.managed !== "subscription",
  );
  const clearSelection = () => setSelected(new Set());
  const filter = (fn: () => void) => {
    clearSelection();
    setPage(0);
    fn();
  };
  const discover = async () => {
    if (range === "manual") {
      try {
        const source = candidate(manualName, manualURL, manualType);
        if (addedIDs.has(source.id)) {
          setNotice("此地址已添加，可在“已添加”中管理。");
          setManualURL("");
          return;
        }
        saveFound([
          ...new Map([...found, source].map((s) => [s.id, s])).values(),
        ]);
        setNotice("已加入候选列表，请检测后添加。");
        setManualURL("");
      } catch (error) {
        toast((error as Error).message, "error");
      }
      return;
    }
    if (range === "web") {
      window.open(
        "https://www.google.com/search?" +
          new URLSearchParams({
            q: `${discoverQuery} m3u api.php/provide/vod`,
          }),
        "_blank",
      );
      setNotice(
        "已在浏览器打开网页搜索。找到的接口或订阅地址可通过“自填地址”导入；应用未接入自动网页检索服务。",
      );
      return;
    }
    discoverRun.current?.abort();
    const controller = new AbortController();
    discoverRun.current = controller;
    setDiscovering(true);
    setNotice("");
    try {
      const response = await fetch(
        "/api/desktop/discover?" +
          new URLSearchParams({ q: discoverQuery || "LibreTV sources" }),
        { signal: controller.signal },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "发现失败");
      saveFound(data.candidates);
      setQuery("");
      setType("all");
      setHealthy(false);
      setRepositories(data.repositories);
      setNotice(data.note);
      clearSelection();
    } catch (error) {
      if (!controller.signal.aborted) setNotice((error as Error).message);
    } finally {
      if (discoverRun.current === controller) setDiscovering(false);
    }
  };
  const cancel = useCallback(() => {
    flushRun.current();
    generation.current++;
    run.current?.abort();
    setProbing(false);
    setPaused(false);
    control.current.setPaused(false);
    setResults((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, value]) => [
          id,
          ["testing", "queued"].includes(value.state)
            ? (previous.current[id] ?? {
                state: "cancelled",
                message: "已取消",
              })
            : value,
        ]),
      ),
    );
  }, []);
  const probe = async (sources: SourceCandidate[]) => {
    if (!sources.length || probing) return;
    const token = ++generation.current,
      controller = new AbortController();
    run.current = controller;
    previous.current = { ...results };
    setProbing(true);
    control.current.setPaused(false);
    setPaused(false);
    const official = createProbeSession();
    let pending: Record<string, ProbeResult> = {};
    let pendingProgress: ProbeProgress | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (generation.current !== token) return;
      const patch = pending;
      pending = {};
      if (Object.keys(patch).length) setResults(current => ({ ...current, ...patch }));
      if (pendingProgress) setProgress(pendingProgress);
    };
    flushRun.current = flush;
    const schedule = () => { if (!timer) timer = setTimeout(flush, 100); };
    try {
      await runProbeBatch([...sources], controller.signal, (id, result) => {
        if (generation.current !== token) return;
        pending[id] = result;
        schedule();
      }, official.probe, undefined, {
        control: control.current,
        onProgress(value) { pendingProgress = value; schedule(); },
      });
    } finally {
      official.flush();
      flush();
      if (generation.current === token) { setProbing(false); setPaused(false); }
    }
  };

  const add = async () => {
    const snapshot = [...addable];
    setBusy(true);
    let success = 0,
      skipped = selectedRows.length - snapshot.length;
    const failures: string[] = [],
      details: string[] = [];
    for (const source of snapshot) {
      try {
        const result = await addCandidate(source);
        if (result === "duplicate") skipped++;
        else {
          success++;
          if (result !== "added") details.push(result);
        }
      } catch (error) {
        failures.push(`${source.name}：${(error as Error).message}`);
      }
    }
    setBusy(false);
    setNotice(
      `已添加 ${success} 项，跳过 ${skipped} 项，失败 ${failures.length} 项。${details.join("；")}${failures.length ? "\n" + failures.join("\n") : ""}`,
    );
    clearSelection();
  };
  const remove = () => {
    const snapshot = [...removable],
      undo: (() => void)[] = [];
    if (
      !snapshot.length ||
      !confirm(`移除所选手动源/订阅，预置源仅停用（${snapshot.length} 项）？`)
    )
      return;
    for (const source of snapshot) {
      try {
        undo.push(removeCandidate(source));
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }
    toast(`已处理 ${undo.length} 项，订阅管理的单独源已跳过`, "info", {
      action: { label: "撤销", onClick: () => undo.forEach((fn) => fn()) },
    });
    clearSelection();
  };
  const done = progress?.done ?? 0;
  const retryable = visible.filter(source => ["failed", "timeout", "abandoned", "cancelled"].includes(results[source.id]?.state));
  const addOne = async (source: SourceCandidate) => {
    setBusy(true);
    try {
      const result = await addCandidate(source);
      setNotice(
        result === "duplicate"
          ? "此地址已存在，已跳过。"
          : result === "added"
            ? "已添加，原版与桌面版立即共用。"
            : result,
      );
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const removeOne = (source: SourceCandidate) => {
    try {
      const undo = removeCandidate(source);
      toast(
        source.managed === "preset" ? "已停用预置源" : "已移除数据源",
        "info",
        { action: { label: "撤销", onClick: undo } },
      );
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const stateLabel = (id: string) =>
    ({
      queued: "排队中",
      testing: "检测中",
      ok: "官方测活通过",
      partial: "部分可用",
      importable: "订阅可导入",
      timeout: "超时",
      failed: "检测失败",
      cancelled: "已取消",
      abandoned: "收尾放弃",
    })[results[id]?.state] ?? "待检测";
  return (
    <>
      <div className="desktop-source-searchbar">
        <FilterSelect
          label="发现范围"
          value={range}
          onChange={setRange}
          options={[
            { value: "github", label: "GitHub" },
            { value: "web", label: "全球网页" },
            { value: "manual", label: "粘贴接口 / 订阅地址" },
          ]}
        />
        {range === "manual" ? (
          <input
            className="desktop-input"
            aria-label="接口或订阅地址"
            placeholder="粘贴接口或订阅地址，例如 https://…/sources.json"
            value={manualURL}
            onChange={(event) => setManualURL(event.target.value)}
          />
        ) : (
          <div className="desktop-search">
            <Search size={16} />
            <input
              type="search"
              aria-label={
                view === "found" ? "搜索关键词或筛选当前结果" : "筛选已添加源"
              }
              placeholder={view === "added" ? "筛选已添加源：名称或地址" : range === "github" ? "关键词或 GitHub 仓库链接；默认 LibreTV sources" : "例如：影视接口、M3U 直播源、数据源订阅"}
              value={view === "found" ? discoverQuery : query}
              onChange={(event) => {
                setDiscoverQuery(event.target.value);
                filter(() => setQuery(event.target.value));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setView("found");
                  void discover();
                }
              }}
            />
            <button
              className="desktop-icon-button"
              aria-label="清空源搜索"
              disabled={!discoverQuery && !query}
              onClick={() => {
                setDiscoverQuery("");
                filter(() => setQuery(""));
              }}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <button
          className="desktop-primary"
          disabled={discovering}
          onClick={() => {
            setView("found");
            void discover();
          }}
        >
          {discovering
            ? "检索中…"
            : range === "manual"
              ? "加入候选"
              : range === "web"
                ? "网页搜索"
                : "发现数据源"}
        </button>
      </div>
      {range === "manual" && (
        <div className="desktop-manual-source">
          <input
            className="desktop-input"
            aria-label="源名称"
            placeholder="名称（选填）"
            value={manualName}
            onChange={(event) => setManualName(event.target.value)}
          />
          <FilterSelect
            label="地址类型"
            value={manualType}
            onChange={(value) => setManualType(value as SourceKind)}
            options={[
              { value: "subscription", label: "订阅配置" },
              { value: "vod", label: "点播接口" },
              { value: "live", label: "直播 M3U" },
            ]}
          />
        </div>
      )}
      <div className="desktop-source-controls">
        <div
          className="desktop-source-views"
          role="group"
          aria-label="数据源视图"
        >
          {[
            ["found", "发现结果"],
            ["added", "已添加"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={view === value}
              onClick={() =>
                filter(() => {
                  setView(value);
                  setQuery("");
                })
              }
            >
              {label}
              <span>{value === "found" ? discovered.length : added.length}</span>
            </button>
          ))}
        </div>
        <div className="desktop-source-filters">
          <FilterSelect
            label="接口类型"
            value={type}
            onChange={(value) => filter(() => setType(value))}
            options={[
              { value: "all", label: "全部类型" },
              { value: "vod", label: "点播接口" },
              { value: "live", label: "直播列表" },
              { value: "subscription", label: "订阅配置" },
            ]}
          />
          <label>
            <input
              type="checkbox"
              role="switch"
              className="desktop-switch"
              checked={healthy}
              onChange={(event) =>
                filter(() => setHealthy(event.target.checked))
              }
            />
            只看可用
          </label>
          <button
            className="desktop-quiet"
            onClick={() =>
              filter(() => {
                setQuery("");
                setDiscoverQuery("");
                setType("all");
                setHealthy(false);
              })
            }
          >
            清除筛选
          </button>
        </div>
      </div>
      <div className="desktop-source-bulk">
        <div className="desktop-source-bulk-main">
          <label>
            <SelectAll
              checked={
                !!visible.length && selectedRows.length === visible.length
              }
              mixed={
                selectedRows.length > 0 && selectedRows.length < visible.length
              }
              onChange={(checked) =>
                setSelected(
                  new Set(checked ? visible.map((source) => source.id) : []),
                )
              }
            />
            <span>
              {selectedRows.length} 项已选
              {view === "found" && selectedRows.length > 0
                ? `，其中 ${addable.length} 项可添加`
                : ""}
            </span>
          </label>
          <div className="desktop-source-bulk-actions">
            <button
              disabled={probing || !selectedRows.length}
              onClick={() => {
                void probe(selectedRows);
              }}
            >
              检测所选
            </button>
            {view === "found" ? (
              <button
                className="desktop-primary"
                disabled={busy || !addable.length}
                title="仅添加已选且检测通过的项目；订阅按地址计数"
                onClick={() => {
                  void add();
                }}
              >
                {busy ? "正在添加…" : `添加已选可用项（${addable.length}）`}
              </button>
            ) : (
              <button
                className="desktop-danger"
                disabled={busy || !removable.length}
                onClick={remove}
              >
                移除 / 停用 <span>{removable.length}</span>
              </button>
            )}
          </div>
        </div>
        <div className="desktop-source-progress">
          <span>
            {probing
              ? `${paused ? "暂停派发" : "正在检测"} · 已完成 ${done}/${progress?.total ?? 0} · 在途 ${progress?.active ?? 0} · 排队 ${progress?.queued ?? 0}`
              : `使用官方测活 · 并发 ${PROBE_CONCURRENCY} · 单项 8 秒 · 慢任务收尾放弃`}
          </span>
          <div className="desktop-actions">
            <button disabled={!probing} onClick={() => { const next = !paused; control.current.setPaused(next); setPaused(next); }}>{paused ? "继续" : "暂停"}</button>
            <button disabled={!probing} onClick={cancel}>终止本轮</button>
            <button disabled={probing || !retryable.length} onClick={() => { void probe(retryable); }}>重测未通过项 {retryable.length || ""}</button>
          </div>
        </div>
        <div className="desktop-probe-track">
          <span
            style={{
              width:
                progress?.total
                  ? `${(done / progress.total) * 100}%`
                  : "0%",
            }}
          />
        </div>
      </div>
      <div className="desktop-source-tablehead">
        <span />
        <span>名称 / 来源</span>
        <span>类型</span>
        <span>检测结果</span>
        <span>响应</span>
        <span>操作</span>
      </div>
      {!visible.length ? (
        <Empty>
          {view === "added" && !added.length
            ? "尚未添加数据源。可以发现公开接口或粘贴已有订阅地址。"
            : (view === "found" ? discovered.length : added.length)
              ? "没有匹配的结果，请清除或调整筛选。"
              : found.length
                ? "本次发现的项目均已添加，可在“已添加”中管理。"
                : "发现数据源后，候选接口将在这里展示。"}
        </Empty>
      ) : (
        <div className="desktop-source-list">
          {pageRows.map((source) => (
            <article
              className="desktop-source-row"
              data-selected={selected.has(source.id)}
              key={source.key ?? source.id}
            >
              <input
                type="checkbox"
                aria-label={`选择 ${source.name}`}
                checked={selected.has(source.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(source.id);
                    else next.delete(source.id);
                    return next;
                  })
                }
              />
              <div className="desktop-source-copy">
                <h3>
                  {source.name}
                </h3>
                <p title={source.url}>{source.url}</p>
                <p>
                  {source.reference ? (
                    <a href={source.reference} target="_blank" rel="noreferrer">
                      {source.origin} ↗
                    </a>
                  ) : (
                    source.origin
                  )}
                  {source.managed === "preset"
                    ? " · 预置源"
                    : source.managed === "subscription"
                      ? " · 由订阅管理"
                      : ""}
                </p>
              </div>
              <span className="desktop-source-type">
                {
                  { vod: "点播", live: "直播", subscription: "订阅" }[
                    source.type
                  ]
                }
              </span>
              <span
                className="desktop-source-health"
                data-result={results[source.id]?.state}
                title={results[source.id]?.message}
              >
                {stateLabel(source.id)}
              </span>
              <span className="desktop-source-latency">
                {results[source.id]?.ms != null
                  ? `${results[source.id].ms} ms`
                  : "—"}
              </span>
              <div className="desktop-source-entry-actions">
                <button
                  disabled={probing}
                  onClick={() => {
                    void probe([source]);
                  }}
                >
                  检测
                </button>
                {view === "found" ? (
                  <button
                    disabled={
                      busy ||
                      !usable(results[source.id]) ||
                      addedIDs.has(source.id)
                    }
                    onClick={() => {
                      void addOne(source);
                    }}
                  >
                    添加
                  </button>
                ) : (
                  <button
                    className={
                      source.managed === "preset" ? "" : "desktop-danger"
                    }
                    disabled={source.managed === "subscription"}
                    title={
                      source.managed === "subscription"
                        ? "请通过对应订阅统一管理"
                        : undefined
                    }
                    onClick={() => removeOne(source)}
                  >
                    {source.managed === "preset" ? "停用" : "移除"}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="desktop-source-foot">
        <span>{visible.length} 个结果 · 第 {currentPage + 1}/{pageCount} 页 · 响应耗时不是带宽</span>
        {pageCount > 1 && <div className="desktop-actions"><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
        <div className="desktop-actions">
          <button
            className="desktop-quiet"
            disabled={probing}
            onClick={() =>
              setSelected(
                new Set(
                  visible
                    .filter((source) => usable(results[source.id]))
                    .map((source) => source.id),
                ),
              )
            }
          >
            选中可用
          </button>
          <button
            className="desktop-quiet"
            disabled={probing || !visible.length}
            onClick={() => {
              void probe(visible);
            }}
          >
            全部检测
          </button>
        </div>
      </div>
      <p className="desktop-source-notice" role="status">
        {notice ||
          "沿用官方测活结果；不代表全部节目可播放。"}
      </p>
      {!!repositories.length && (
        <details className="desktop-source-provenance">
          <summary>查看候选来源</summary>
          {repositories.map((repo) => (
            <a key={repo.url} href={repo.url} target="_blank" rel="noreferrer">
              {repo.name} ↗
            </a>
          ))}
        </details>
      )}
    </>
  );
}
