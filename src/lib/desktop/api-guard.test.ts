import { afterEach, describe, expect, it, vi } from "vitest";
import { guardDesktopRequest } from "./api-guard";
afterEach(() => vi.unstubAllEnvs());
describe("independent desktop API session", () => {
  it("accepts the native credential without relying on the official core cookie format", () => {
    vi.stubEnv("LIBRETV_DESKTOP_CONFIG", "/private/config.json");
    vi.stubEnv("LIBRETV_DESKTOP_API_KEY", "test-session");
    vi.stubEnv("LIBRETV_DESKTOP_ORIGIN", "http://127.0.0.1:17891");
    expect(
      guardDesktopRequest(
        new Request("http://127.0.0.1:30001/api/desktop/cache", {
          headers: {
            cookie: "ltv_desktop=test-session",
            origin: "http://127.0.0.1:17891",
          },
        }),
      ),
    ).toBeNull();
  });
  it("rejects foreign origins and forged or missing credentials", () => {
    vi.stubEnv("LIBRETV_DESKTOP_CONFIG", "/private/config.json");
    vi.stubEnv("LIBRETV_DESKTOP_API_KEY", "test-session");
    for (const headers of [
      { cookie: "ltv_desktop=bad" },
      { cookie: "ltv_desktop=test-session", origin: "https://foreign.test" },
      {},
    ] as Record<string, string>[])
      expect(
        guardDesktopRequest(
          new Request("http://127.0.0.1:17891/api/desktop/cache", { headers }),
        )?.status,
      ).toBeGreaterThanOrEqual(401);
  });
});
