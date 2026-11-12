import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DiskMediaCache } from "./disk-cache";
let temp: string, configPath: string, root: string, cache: DiskMediaCache;
const meta = { episodeKey: "episode-1", index: 1, costMs: 52 };
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "libretv-cache-test-"));
  root = path.join(temp, "media");
  configPath = path.join(temp, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ cacheDirectory: root }),
  );
  cache = new DiskMediaCache(configPath);
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});
async function pending(target: string) {
  const conf = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    JSON.stringify({ ...conf, pendingCacheDirectory: target }),
  );
}
describe("native disk media cache", () => {
  it("reconciles crash leftovers and stale size metadata without touching unrelated files", async () => {
    await cache.put("https://video.test/1.ts", Buffer.from("video"), meta);
    const indexFile = path.join(root, "index.json"), index = JSON.parse(await fs.readFile(indexFile, "utf8"));
    const id = Object.keys(index)[0];
    index[id].bytes = 900;
    await fs.writeFile(indexFile, JSON.stringify(index));
    await fs.writeFile(path.join(root, "a".repeat(64) + ".bin"), "orphan");
    await fs.writeFile(path.join(root, "index-11111111-1111-4111-8111-111111111111.tmp"), "incomplete");
    await fs.writeFile(path.join(root, "keep.mp4"), "user-file");
    const restored = new DiskMediaCache(configPath);
    expect((await restored.summary()).bytes).toBe(5);
    expect(await restored.put("https://video.test/2.ts", Buffer.alloc(600), { ...meta, index: 2 })).toBe(true);
    expect(await fs.readdir(root)).not.toContain("a".repeat(64) + ".bin");
    expect(await fs.readFile(path.join(root, "keep.mp4"), "utf8")).toBe("user-file");
  });
  it("round trips binary bytes, persists across instances, and clears only managed segments", async () => {
    const buffer = Buffer.from([0, 1, 255, 0, 32]);
    expect(await cache.put("https://video.test/1.ts", buffer, meta)).toBe(
      true,
    );
    const restored = new DiskMediaCache(configPath);
    expect((await restored.get("https://video.test/1.ts"))?.buffer).toEqual(
      buffer,
    );
    await fs.writeFile(path.join(root, "my-film.mp4"), "user-file");
    await restored.clear();
    expect(await fs.readFile(path.join(root, "my-film.mp4"), "utf8")).toBe(
      "user-file",
    );
    expect((await restored.summary()).segments).toBe(0);
  });
  it("leaves quota and eviction policy to official CacheStorage callers", async () => {
    expect(
      await cache.put("https://video.test/1", Buffer.alloc(800), meta),
    ).toBe(true);
    expect(
      await cache.put(
        "https://video.test/2",
        Buffer.alloc(800),
        { ...meta, index: 2 },
      ),
    ).toBe(true);
    expect((await cache.summary()).bytes).toBe(1600);
    await cache.removeKey("https://video.test/1");
    expect((await cache.summary()).bytes).toBe(800);
  });
  it("keeps download chunks when playback cache is cleared and isolates buckets", async () => {
    const downloadKey = "https://dl.libretv.local/task-1/0";
    await cache.put("https://video.test/1.ts", Buffer.from("video"), meta);
    await cache.put(downloadKey, Buffer.from("download"), { ...meta, episodeKey: "download:task-1" });
    expect(await cache.keys("libretv-dl-v1")).toEqual([downloadKey]);
    await cache.clear();
    expect(await cache.get("https://video.test/1.ts")).toBeNull();
    expect((await cache.get(downloadKey))?.buffer.toString()).toBe("download");
    await cache.clearBucket("libretv-dl-v1");
    expect((await cache.summary()).segments).toBe(0);
  });
  it("copies and verifies before switching, leaving the old cache available", async () => {
    const data = Buffer.from("test-video-segment");
    await cache.put("https://video.test/1", data, meta);
    const target = path.join(temp, "new-cache");
    await pending(target);
    await cache.move(true);
    expect((await cache.summary()).directory).toBe(target);
    expect((await cache.get("https://video.test/1"))?.buffer).toEqual(data);
    expect((await fs.readdir(root)).some((name) => name.endsWith(".bin"))).toBe(
      true,
    );
    await fs.writeFile(path.join(root, "keep.txt"), "keep");
    await cache.clearOld();
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep");
  });
  it("cancels migration while preserving old configuration and bytes", async () => {
    await cache.put("https://video.test/1", Buffer.from("keep"), meta);
    await pending(path.join(temp, "cancelled"));
    const moving = cache.move(true);
    cache.cancelMigration();
    await expect(moving).rejects.toThrow("取消");
    expect((await cache.summary()).directory).toBe(root);
    expect((await cache.get("https://video.test/1"))?.buffer.toString()).toBe(
      "keep",
    );
  });
  it("rejects a destination containing unrelated files without removing them", async () => {
    await cache.summary();
    const target = path.join(temp, "not-empty");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "movie.mp4"), "user-film");
    await pending(target);
    await expect(cache.move(true)).rejects.toThrow("其他文件");
    expect((await cache.summary()).directory).toBe(root);
    expect(await fs.readFile(path.join(target, "movie.mp4"), "utf8")).toBe(
      "user-film",
    );
  });
  it("switches without migration and records the old cache separately", async () => {
    await cache.put("https://video.test/1", Buffer.from("keep"), meta);
    const target = path.join(temp, "empty-cache");
    await pending(target);
    await cache.move(false);
    expect((await cache.summary()).bytes).toBe(0);
    expect((await cache.summary()).oldDirectories).toEqual([root]);
    expect((await fs.readdir(root)).some((name) => name.endsWith(".bin"))).toBe(
      true,
    );
  });
});
