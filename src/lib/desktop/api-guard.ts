import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { guardRequest } from "../api-guard";
/** Independent desktop credential: upstream can change its session implementation without breaking native file APIs. */
export function guardDesktopRequest(req: Request): NextResponse | null {
  if (!process.env.LIBRETV_DESKTOP_CONFIG)
    return new NextResponse(null, { status: 404 });
  const expected = process.env.LIBRETV_DESKTOP_API_KEY;
  if (!expected) return guardRequest(req); // standalone developer tests only
  const raw =
    (req.headers.get("cookie") || "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("ltv_desktop="))
      ?.slice("ltv_desktop=".length) || "";
  const a = Buffer.from(raw),
    b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return NextResponse.json({ error: "桌面会话无效" }, { status: 401 });
  const origin = req.headers.get("origin");
  if (
    (origin &&
      origin !==
        (process.env.LIBRETV_DESKTOP_ORIGIN || new URL(req.url).origin)) ||
    req.headers.get("sec-fetch-site") === "cross-site"
  )
    return NextResponse.json({ error: "拒绝跨站桌面请求" }, { status: 403 });
  return null;
}
