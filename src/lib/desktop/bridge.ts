export interface DesktopPreferences {
  cacheDirectory: string;
  downloadDirectory: string;
  exportDirectory: string;
  pendingCacheDirectory?: string;
  askEachTime: boolean;
  appearance: "system" | "light" | "dark";
  checkOnLaunch?: boolean;
  activeDownloads?: number;
}
export interface UpdateStatus {
  phase: string;
  message: string;
  version: string;
  currentVersion: string;
  notes: string;
  releaseURL: string;
  received: number;
  expected: number;
  canInstall: boolean;
  hasRollback?: boolean;
}
export interface DiskCacheSummary {
  bytes: number;
  segments: number;
  episodes: number;
  directory: string;
  migration: {
    phase: string;
    completed: number;
    total: number;
    message: string;
  };
  oldDirectories: string[];
}
declare global {
  interface Window {
    libreTVDesktop?: {
      version: number;
      call<T = unknown>(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<T>;
    };
  }
}
export function isDesktop(): boolean {
  return typeof window !== "undefined" && window.libreTVDesktop?.version === 1;
}
export async function desktopCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!isDesktop()) throw new Error("此操作需要 LibreTV Mac 桌面应用");
  return window.libreTVDesktop!.call<T>(method, params);
}
export async function diskCacheRequest<T = DiskCacheSummary>(
  action?: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(
    "/api/desktop/cache",
    action
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        }
      : undefined,
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "媒体缓存请求失败");
  return body as T;
}
