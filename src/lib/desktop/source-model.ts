export type SourceKind = "vod" | "live" | "subscription";
export interface SourceCandidate {
  id: string;
  name: string;
  url: string;
  type: SourceKind;
  origin: string;
  reference?: string;
  added?: boolean;
  managed?: "manual" | "preset" | "subscription";
  key?: string;
}
export interface ProbeResult {
  state:
    | "queued"
    | "testing"
    | "ok"
    | "partial"
    | "importable"
    | "timeout"
    | "failed"
    | "cancelled"
    | "abandoned";
  ms?: number;
  message: string;
  count?: number;
}
export function normalizedURL(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("只支持不含账号密码的 HTTP(S) 地址");
  url.hash = "";
  return url.href.replace(/\/$/, "").replace(/\?$/, "");
}
export function candidate(
  name: string,
  url: string,
  type: SourceKind,
  origin = "自填地址",
  reference?: string,
): SourceCandidate {
  const normalized = normalizedURL(url);
  return {
    id: `${type}:${normalized}`,
    name: name || new URL(normalized).hostname,
    url: normalized,
    type,
    origin,
    reference,
  };
}
