import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  if (!process.env.LIBRETV_DESKTOP_INSTANCE)
    return new NextResponse(null, { status: 404 });
  return NextResponse.json({
    instance: process.env.LIBRETV_DESKTOP_INSTANCE,
    version: process.env.APP_VERSION,
    adapterVersion: 1,
    capabilities: ["native-save-v1", "disk-media-cache-v1", "shared-store-v1"],
  });
}
