"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  desktopCall,
  diskCacheRequest,
  isDesktop,
  type DesktopPreferences,
  type DiskCacheSummary,
  type UpdateStatus,
} from "@/lib/desktop/bridge";
import { Folder, FolderOpen, GitBranch, ExternalLink } from "lucide-react";
import { useTheme, type ThemeChoice } from "@/components/theme";
import { useToast } from "@/components/toast";
import { PageHeading, SettingRow, Empty, bytes } from "./controls";

export function DesktopTheme() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <PageHeading title="主题" description="与原版共用外观设置，外壳跟随官方配色。" />
      <div className="desktop-theme-choices">
        {(
          [
            ["system", "跟随系统"],
            ["light", "浅色"],
            ["dark", "深色"],
          ] as [ThemeChoice, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={theme === value}
            onClick={() => {
              setTheme(value);
            }}
          >
            <span className={`desktop-theme-sample ${value}`} />
            <strong>{label}</strong>
          </button>
        ))}
      </div>
    </>
  );
}
export function DesktopStorage() {
  const displayPath = (value?: string) =>
    value?.replace(/^\/Users\/[^/]+/, "~") ?? "正在读取…";
  const [prefs, setPrefs] = useState<DesktopPreferences>();
  const [summary, setSummary] = useState<Pick<DiskCacheSummary, "directory" | "migration" | "oldDirectories">>();
  const [pending, setPending] = useState<string>();
  const [migrate, setMigrate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const { toast } = useToast();
  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        desktopCall<DesktopPreferences>("preferences.get"),
        diskCacheRequest<Pick<DiskCacheSummary, "directory" | "migration" | "oldDirectories">>("status"),
      ]);
      setPrefs(p);
      setSummary(s);
      setPending(p.pendingCacheDirectory);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    if (isDesktop()) {
      void refresh();
      const timer = setInterval(() => {
        void refresh();
      }, 2000);
      return () => clearInterval(timer);
    }
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const choose = async (kind: "cache" | "download" | "export", reset = false) => {
    await run(async () => {
      const result = await desktopCall<{ path: string }>("directory.choose", {
        kind,
        reset,
      });
      if (kind === "cache") setPending(result.path);
    });
  };
  const moving = ["preparing", "copying"].includes(
    summary?.migration.phase ?? "",
  );
  if (!isDesktop())
    return (
      <Empty>
        下载目录和媒体缓存由 Mac 应用管理，请在桌面应用中打开此页面。
      </Empty>
    );
  return (
    <>
      <h2>文件保存位置</h2>
      {error && (
        <p role="alert" className="desktop-error">
          {error}
        </p>
      )}
      {(["download", "export", "cache"] as const).map((kind) => (
        <Fragment key={kind}>
          <div className="desktop-path">
            <h3>{kind === "download" ? "下载位置" : kind === "export" ? "配置与数据导出位置" : "播放缓存位置"}</h3>
            <p>
              {kind === "download"
                ? "用于新下载任务；已完成和进行中的任务保留原位置。"
                : kind === "export" ? "官方导出的配置、数据源文件保存到此处。" : "官方管理缓存策略，桌面版只提供分片文件的存放目录。"}
            </p>
            <div className="desktop-path-controls">
              <div className="desktop-path-display">
                <Folder size={16} />
                <span
                  title={
                    kind === "download"
                      ? prefs?.downloadDirectory
                      : kind === "export" ? prefs?.exportDirectory : prefs?.cacheDirectory
                  }
                >
                  {displayPath(
                    kind === "download"
                      ? prefs?.downloadDirectory
                      : kind === "export" ? prefs?.exportDirectory : prefs?.cacheDirectory,
                  )}
                </span>
              </div>
              <button
                disabled={
                  busy ||
                  moving ||
                  (kind === "cache" && (prefs?.activeDownloads ?? 0) > 0)
                }
                onClick={() => {
                  void choose(kind);
                }}
              >
                更改…
              </button>
              <button
                className="desktop-icon-button"
                title="在访达中打开"
                aria-label={`在访达中打开${kind === "download" ? "下载位置" : kind === "export" ? "导出位置" : "播放缓存位置"}`}
                disabled={!prefs}
                onClick={() => {
                  void run(() => desktopCall("directory.reveal", { kind }));
                }}
              >
                <FolderOpen size={16} />
              </button>
              <button
                className="desktop-quiet"
                disabled={busy || moving}
                onClick={() => {
                  void choose(kind, true);
                }}
              >
                默认
              </button>
            </div>
          </div>
        </Fragment>
      ))}
      <SettingRow title="保存前询问位置" description="用于影片下载及配置、数据源导出；关闭后直接存到各自目录。">
        <input className="desktop-switch" type="checkbox" role="switch" aria-label="保存前询问位置" checked={prefs?.askEachTime ?? false} disabled={!prefs || moving || busy} onChange={e => { void run(() => desktopCall("preferences.set", { askEachTime:e.target.checked })); }} />
      </SettingRow>
      {pending && !moving && (
        <div className="desktop-card" role="region" aria-label="切换缓存目录">
          <h3>切换缓存目录</h3>
          <p className="desktop-break">{pending}</p>
          <label>
            <input
              type="checkbox"
              checked={migrate}
              onChange={(e) => setMigrate(e.target.checked)}
            />{" "}
            迁移现有临时缓存（复制并校验后切换）
          </label>
          <p>
            旧目录保持可用；失败或取消不会删除旧缓存。成功后仍可单独清理旧目录。
          </p>
          <div className="desktop-actions">
            <button
              className="desktop-primary"
              disabled={busy || moving}
              onClick={() => {
                void run(async () => {
                  await diskCacheRequest("move", { migrate });
                  setPending(undefined);
                });
              }}
            >
              应用目录变更
            </button>
            <button onClick={() => { void run(() => desktopCall("directory.cancel")); }}>取消</button>
          </div>
        </div>
      )}
      {moving && (
        <div className="desktop-card" role="status">
          <p>{summary?.migration.message}</p>
          <progress
            value={summary?.migration.completed}
            max={summary?.migration.total || 1}
          />
          <button
            onClick={() => {
              void run(() => diskCacheRequest("cancelMove"));
            }}
          >
            取消迁移
          </button>
        </div>
      )}
      {summary?.migration.message && !moving && (
        <p
          className={
            summary.migration.phase === "error"
              ? "desktop-error"
              : "desktop-note"
          }
          role="status"
        >
          {summary.migration.message}
        </p>
      )}

      <p className="desktop-note">观看历史、数据源与偏好设置由两种模式共用。下载和缓存策略请在原版设置中调整；配置备份使用官方导出功能。</p>
      <details className="desktop-maintenance">
        <summary>诊断与维护</summary>
        <div className="desktop-actions">
          <button onClick={() => { void run(async () => setDiagnostics(await desktopCall<string>("service.diagnostics"))); }}>查看诊断信息</button>
          <button onClick={() => { void desktopCall("service.logs"); }}>打开日志文件夹</button>
          <button disabled={(prefs?.activeDownloads ?? 0) > 0} onClick={() => { if(confirm("将保存播放进度并短暂重启本地服务，是否继续？"))void desktopCall("service.restart"); }}>重新启动本地服务</button>
        </div>
        {diagnostics && <pre className="desktop-diagnostics">{diagnostics}</pre>}
      </details>
    </>
  );
}
export function DesktopUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [prefs, setPrefs] = useState<DesktopPreferences>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isDesktop()) return;
    void desktopCall<DesktopPreferences>("preferences.get").then(setPrefs);
    const refresh = () => {
      void desktopCall<UpdateStatus>("update.status")
        .then(setStatus)
        .catch((err) => setError(err.message));
    };
    refresh();
    const timer = setInterval(refresh, 800);
    return () => clearInterval(timer);
  }, []);
  const action = async (method: string) => {
    try {
      setStatus(await desktopCall<UpdateStatus>(method));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!isDesktop()) return <Empty>本机内核更新需要在 Mac 应用中操作。</Empty>;
  const working = [
    "checking",
    "downloading",
    "verifying",
    "installing",
  ].includes(status?.phase ?? "");
  return (
    <>
      <div className="desktop-update-sources">
        <span>
          <GitBranch size={14} />
          GitHub Releases
        </span>
        <a href="https://libretv.is-an.org/" target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          官网公告
        </a>
      </div>
      <div className="desktop-card">
        <div className="desktop-versions">
          <div>
            <p>当前本机内核</p>
            <strong>{status?.currentVersion || "正在读取…"}</strong>
          </div>
          <div>
            <p>官方最新版本</p>
            <strong>{status?.version || "尚未检查"}</strong>
          </div>
        </div>
        <div className="desktop-update-status" role="status">
          <h3>{status?.message || "正在读取更新状态…"}</h3>
          {error && <p className="desktop-error">{error}</p>}
          {status?.phase === "downloading" && (
            <>
              <progress
                {...(status.expected > 0
                  ? { value: status.received, max: status.expected }
                  : {})}
                aria-label="更新包下载"
              />
              <p>
                {bytes(status.received)}
                {status.expected > 0 ? ` / ${bytes(status.expected)}` : ""}
              </p>
            </>
          )}
        </div>
        <div className="desktop-actions">
          <button
            className="desktop-primary"
            disabled={working}
            onClick={() => {
              void action("update.check");
            }}
          >
            检查官方更新
          </button>
          {status?.canInstall && (
            <button
              className="desktop-primary"
              onClick={() => {
                if (
                  confirm(
                    "更新会停止当前测活、保存播放进度并备份本机数据，随后重启本地服务，是否继续？",
                  )
                )
                  void action("update.install");
              }}
            >
              备份并更新本地服务
            </button>
          )}
          {status?.hasRollback && (
            <button
              disabled={working}
              onClick={() => {
                if (
                  confirm(
                    "恢复上一内核和更新前的数据备份？回退前会另行保存当前数据快照。",
                  )
                )
                  void action("update.rollback");
              }}
            >
              回退上一内核
            </button>
          )}
          {["available", "paused", "error"].includes(status?.phase ?? "") &&
            !!status?.version && (
              <button
                onClick={() => {
                  void action("update.download");
                }}
              >
                {status?.phase === "paused" ? "继续下载" : "下载并校验"}
              </button>
            )}
          {status?.phase === "downloading" && (
            <button
              onClick={() => {
                void action("update.pause");
              }}
            >
              暂停
            </button>
          )}
          {["downloading", "paused"].includes(status?.phase ?? "") && (
            <button
              onClick={() => {
                void action("update.cancel");
              }}
            >
              取消下载
            </button>
          )}
        </div>
      </div>
      <SettingRow
        title="启动时检查"
        description="只检查与提示，由你手动准备更新。"
      >
        <input
          className="desktop-switch"
          type="checkbox"
          role="switch"
          aria-label="启动时检查内核更新"
          checked={prefs?.checkOnLaunch ?? false}
          onChange={(e) => {
            void desktopCall<DesktopPreferences>("preferences.set", {
              checkOnLaunch: e.target.checked,
            }).then(setPrefs);
          }}
        />
      </SettingRow>
      <section className="desktop-release-notes">
        <h2>官方发布说明</h2>
        <pre>{status?.notes || "检查更新后显示官方原文。"}</pre>
        <div className="desktop-actions">
          <a
            href={
              status?.releaseURL ||
              "https://github.com/LibreSpark/LibreTV/releases"
            }
            target="_blank"
            rel="noreferrer"
          >
            完整发布记录 ↗
          </a>
          <a href="https://libretv.is-an.org/" target="_blank" rel="noreferrer">
            官网与文档 ↗
          </a>
        </div>
      </section>
      <p className="desktop-note">
        官方内核可单独更新，桌面功能与设置保留。更新包会先校验并检查兼容性；
        不通过则保留现有内核，通过后由你确认备份并安装。
        新版若改变官方接口或数据结构，需要先更新桌面应用。
      </p>
    </>
  );
}
