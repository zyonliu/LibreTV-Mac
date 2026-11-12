"use client";
import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { RefreshCw, HardDrive } from "lucide-react";
import { DesktopTheme, DesktopStorage, DesktopUpdates } from "./settings";
import { DesktopSources } from "./sources";
import { PageHeading } from "./controls";

const tabs = [
  ["original", "原版设置"],
  ["desktop", "桌面版设置"],
  ["sources", "找源"],
  ["updates", "更新"],
];

/** Only desktop additions live here. Discovery, live TV, history and playback use the official release. */
export function DesktopShell() {
  const params = useSearchParams(), router = useRouter();
  const view = params.get("view") || "settings", tab = params.get("tab") || "desktop";
  const navigate = (id: string) => router.push("/desktop?view=settings&tab=" + id, { scroll: false });
  const active = view === "history" ? "history" : view === "theme" ? "theme" : tab;
  const [visited, setVisited] = useState(() => new Set([active]));
  useEffect(() => { setVisited(previous => previous.has(active) ? previous : new Set([...previous, active])); }, [active]);
  return (
    <main className="desktop-content desktop-additions" data-official-panel={active === "original" || active === "history"}>
      {active !== "theme" && <PageHeading
        title={active === "history" ? "历史" : active === "theme" ? "主题" : tabs.find(([id]) => id === tab)?.[1] ?? "桌面版设置"}
        description={{ original: "直接使用官方设置，两种模式共用。", desktop: "设置下载、配置导出与缓存文件的保存位置。", sources: "发现、检测和管理同一份本机数据源。", updates: "检查官方版本与本地适配能力。", history: "继续观看，或查找看过的影片。" }[active] || "管理本机应用设置。"}
      >
        {active === "sources" ? <span className="desktop-glass-tag"><RefreshCw size={13} />与原版共用</span> : active === "updates" ? <span className="desktop-glass-tag"><HardDrive size={13} />本地自用</span> : null}
      </PageHeading>}
      <div className="desktop-tabs" role="group" aria-label="设置分类" hidden={view !== "settings"}>
        {tabs.map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => navigate(id)}>{label}</button>)}
      </div>
      {(["original", "sources", "updates", "desktop", "history", "theme"] as const).map(id =>
        (visited.has(id) || active === id) && <section className="desktop-retained-pane" key={id} hidden={active !== id}>
          {id === "original" ? <OfficialPanel kind="settings" /> : id === "history" ? <OfficialPanel kind="history" /> : id === "sources" ? <DesktopSources /> : id === "updates" ? <DesktopUpdates /> : id === "theme" ? <DesktopTheme /> : <DesktopStorage />}
        </section>
      )}
    </main>
  );
}

function OfficialPanel({ kind }: { kind: "settings" | "history" }) {
  return <iframe className="desktop-official-panel" title={kind === "settings" ? "官方设置" : "官方观看历史"} src={`/?desktopPanel=${kind}`} />;
}
