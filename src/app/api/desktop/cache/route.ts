import { NextResponse } from "next/server";
import { guardDesktopRequest } from "@/lib/desktop/api-guard";
import { desktopDiskCache } from "@/lib/desktop/disk-cache";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function guard(req: Request) {
  if (!process.env.LIBRETV_DESKTOP_CONFIG)
    return new NextResponse(null, { status: 404 });
  const denied = guardDesktopRequest(req);
  if (denied) return denied;
  return null;
}
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const key = new URL(req.url).searchParams.get("key");
    const cache = desktopDiskCache();
    if (!key) return NextResponse.json(await cache.summary());
    const result = await cache.get(key);
    if (!result) return new NextResponse(null, { status: 404 });
    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Cost-Ms": String(result.costMs),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
export async function PUT(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const sp = new URL(req.url).searchParams,
      key = sp.get("key");
    if (!key || key.length > 16000) throw new Error("缓存 key 无效");
    const reader = req.body?.getReader();
    if (!reader) throw new Error("分片为空");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 64 * 1024 * 1024) {
        await reader.cancel();
        return NextResponse.json({ error: "单分片超过 64MB" }, { status: 413 });
      }
      chunks.push(value);
    }
    const ok = await desktopDiskCache().put(
      key,
      Buffer.concat(chunks),
      {
        episodeKey: sp.get("episode") ?? "",
        index: Number(sp.get("index")) || 0,
        costMs: Number(sp.get("cost")) || 150,
      },
    );
    return NextResponse.json({ ok });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const body = await req.json(),
      cache = desktopDiskCache();
    switch (body.action) {
      case "status":
        return NextResponse.json(await cache.status());
      case "keys":
        return NextResponse.json({ keys: await cache.keys(body.bucket) });
      case "removeKey":
        if (typeof body.key !== "string") throw new Error("无效的缓存 key");
        await cache.removeKey(body.key);
        break;
      case "clearBucket":
        await cache.clearBucket(body.bucket);
        break;
      case "clear":
        await cache.clear();
        break;
      case "episode":
        if (typeof body.episode !== "string" || !body.episode)
          throw new Error("剧集标识为空");
        await cache.clear(body.episode);
        break;
      case "move":
        void cache.move(body.migrate === true).catch(() => {});
        break;
      case "cancelMove":
        cache.cancelMigration();
        break;
      case "clearOld":
        await cache.clearOld();
        break;
      default:
        throw new Error("未知缓存操作");
    }
    return NextResponse.json(await cache.summary());
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
