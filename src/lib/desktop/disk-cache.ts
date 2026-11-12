import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

interface Entry {
  key: string;
  episodeKey: string;
  index: number;
  bytes: number;
  costMs: number;
  lastAccess: number;
}
interface Configuration {
  cacheDirectory: string;
  pendingCacheDirectory?: string;
  oldCacheDirectories?: string[];
  [key: string]: unknown;
}
const MARKER = ".libretv-media-v1";
const digest = (key: string) => createHash("sha256").update(key).digest("hex");

/** Stores only regenerable segments. All paths come from the native-owned config, never HTTP input. */
export class DiskMediaCache {
  private index: Record<string, Entry> = {};
  private root = "";
  private tail: Promise<unknown> = Promise.resolve();
  private moving = false;
  private migration: {
    phase: string;
    completed: number;
    total: number;
    message: string;
  } = { phase: "idle", completed: 0, total: 0, message: "" };
  private cancelMove = false;
  constructor(private configPath: string) {}
  private async config(): Promise<Configuration> {
    return JSON.parse(
      await fs.readFile(this.configPath, "utf8"),
    ) as Configuration;
  }
  private async saveConfig(next: Partial<Configuration>) {
    const current = await this.config();
    Object.assign(current, next);
    const temp = `${this.configPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(current, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.configPath);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn, fn);
    this.tail = task.catch(() => {});
    return task;
  }
  private async prepare(root: string) {
    if (!path.isAbsolute(root) || root === path.parse(root).root)
      throw new Error("缓存目录无效");
    // Never recreate an unavailable external mount at /Volumes.
    if (root.startsWith("/Volumes/")) await fs.access(root);
    await fs.mkdir(root, { recursive: true });
    if ((await fs.lstat(root)).isSymbolicLink())
      throw new Error("缓存目录不能是符号链接");
    try {
      const marker = await fs.readFile(path.join(root, MARKER), "utf8");
      if (marker !== "LibreTV Media Cache v1\n")
        throw new Error("缓存标识不匹配");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await fs.readdir(root)).length)
        throw new Error("目标目录包含其他文件，请选择空目录");
      try {
        await fs.writeFile(path.join(root, MARKER), "LibreTV Media Cache v1\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (await fs.readFile(path.join(root, MARKER), "utf8")) !== "LibreTV Media Cache v1\n") throw error;
      }
    }
  }
  private async load() {
    const conf = await this.config();
    if (this.root === conf.cacheDirectory) return conf;
    await this.prepare(conf.cacheDirectory);
    let index: Record<string, Entry> = {};
    try {
      index = JSON.parse(
        await fs.readFile(path.join(conf.cacheDirectory, "index.json"), "utf8"),
      );
      if (!index || typeof index !== "object" || Array.isArray(index)) throw new Error("Invalid cache index");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("缓存索引损坏，请选择新的空缓存目录；原文件保留。");
    }
    this.index = Object.fromEntries(
      Object.entries(index).filter(
        ([id, entry]) =>
          /^[a-f0-9]{64}$/.test(id) &&
          entry &&
          typeof entry.key === "string" &&
          digest(entry.key) === id &&
          Number.isFinite(entry.bytes) &&
          entry.bytes >= 0,
      ),
    );
    this.root = conf.cacheDirectory;
    // A crash can happen after segment rename but before index commit. Reconcile only our file names.
    const files = await fs.readdir(this.root);
    for (const name of files) {
      const id = name.slice(0, -4);
      if (/^[a-f0-9]{64}\.bin$/.test(name) && !this.index[id]) await fs.rm(path.join(this.root, name), { force: true });
      if (/^(?:[a-f0-9]{64}\.|index-)[a-f0-9-]{36}\.tmp$/.test(name)) await fs.rm(path.join(this.root, name), { force: true });
    }
    for (const [id, entry] of Object.entries(this.index)) {
      try { entry.bytes = (await fs.stat(path.join(this.root, id + ".bin"))).size; }
      catch { delete this.index[id]; continue; }
      entry.lastAccess = Number.isFinite(entry.lastAccess) ? entry.lastAccess : 0;
      entry.episodeKey = typeof entry.episodeKey === "string" ? entry.episodeKey : entry.key;
    }
    return conf;
  }
  private async persist() {
    const temp = path.join(this.root, `index-${randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify(this.index), { mode: 0o600 });
    await fs.rename(temp, path.join(this.root, "index.json"));
  }
  async get(key: string): Promise<{ buffer: Buffer; costMs: number } | null> {
    await this.load();
    const id = digest(key),
      entry = this.index[id];
    if (!entry) return null;
    try {
      const buffer = await fs.readFile(path.join(this.root, id + ".bin"));
      if (!this.moving) entry.lastAccess = Date.now();
      return { buffer, costMs: entry.costMs };
    } catch {
      return null;
    }
  }
  async put(
    key: string,
    buffer: Buffer,
    meta: Pick<Entry, "episodeKey" | "index" | "costMs">,
  ) {
    if (this.moving) return false;
    return this.serial(async () => {
      if (this.moving) return false;
      await this.load();
      const id = digest(key);
      // Official LibreTV owns cache quotas and eviction through CacheStorage. The host only stores bytes.
      const disk = await fs.statfs(this.root);
      if (Number(disk.bavail) * Number(disk.bsize) < buffer.length + 32 * 1024 * 1024) return false;
      const temp = path.join(this.root, `${id}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, buffer, { mode: 0o600 });
        await fs.rename(temp, path.join(this.root, id + ".bin"));
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
      this.index[id] = {
        key,
        ...meta,
        bytes: buffer.length,
        lastAccess: Date.now(),
      };
      await this.persist();
      return true;
    });
  }
  private async remove(id: string) {
    await fs.rm(path.join(this.root, id + ".bin"), { force: true });
    delete this.index[id];
  }
  async summary() {
    const conf = await this.load();
    let bytes = 0,
      segments = 0;
    const episodes = new Set<string>();
    // Stat actual files so the displayed usage is not a simulated metadata number.
    for (const [id, e] of Object.entries(this.index)) {
      try {
        bytes += (await fs.stat(path.join(this.root, id + ".bin"))).size;
        segments++;
        episodes.add(e.episodeKey);
      } catch {
        /* externally removed entry */
      }
    }
    return {
      bytes,
      segments,
      episodes: episodes.size,
      directory: this.root,
      migration: this.migration,
      oldDirectories: conf.oldCacheDirectories ?? [],
    };
  }
  async status() {
    const conf = await this.config();
    return { directory: conf.cacheDirectory, migration: this.migration, oldDirectories: conf.oldCacheDirectories ?? [] };
  }
  async keys(bucket: string): Promise<string[]> {
    await this.load();
    const download = bucket === "libretv-dl-v1";
    return Object.values(this.index)
      .map((e) => e.key)
      .filter(
        (key) => key.startsWith("https://dl.libretv.local/") === download,
      );
  }
  async removeKey(key: string) {
    return this.serial(async () => {
      if (this.moving) throw new Error("缓存正在迁移");
      await this.load();
      await this.remove(digest(key));
      await this.persist();
    });
  }
  async clearBucket(bucket: string) {
    const keys = await this.keys(bucket);
    for (const key of keys) await this.removeKey(key);
  }
  async clear(episodeKey?: string) {
    return this.serial(async () => {
      if (this.moving) throw new Error("缓存正在迁移，请稍后清理");
      await this.load();
      for (const [id, e] of Object.entries(this.index))
        if (episodeKey ? e.episodeKey === episodeKey : !e.key.startsWith("https://dl.libretv.local/"))
          await this.remove(id);
      await this.persist();
    });
  }
  cancelMigration() {
    this.cancelMove = true;
  }
  async move(migrate: boolean) {
    if (this.moving) throw new Error("已有缓存迁移任务");
    this.moving = true;
    this.cancelMove = false;
    this.migration = {
      phase: "preparing",
      completed: 0,
      total: 0,
      message: "检查目标目录",
    };
    return this.serial(async () => {
      let staging = "";
      try {
        const conf = await this.load(),
          from = this.root,
          to = conf.pendingCacheDirectory;
        if (!to) throw new Error("请先通过系统选择器选择缓存目录");
        if (to === from) {
          this.migration.phase = "complete";
          return;
        }
        if (to.startsWith(from + path.sep) || from.startsWith(to + path.sep))
          throw new Error("新旧缓存目录不能互相包含");
        await this.prepare(to);
        if (migrate) {
          if ((await fs.readdir(to)).some((name) => name !== MARKER))
            throw new Error("迁移目标必须为空的 LibreTV 缓存目录");
          const entries = Object.keys(this.index);
          this.migration.total = entries.length;
          const stat = await fs.statfs(to),
            required = Object.values(this.index).reduce(
              (sum, entry) => sum + entry.bytes,
              0,
            );
          if (
            Number(stat.bavail) * Number(stat.bsize) <
            required + 32 * 1024 * 1024
          )
            throw new Error("目标磁盘空间不足");
          staging = path.join(to, `.migrating-${randomUUID()}`);
          await fs.mkdir(staging);
          this.migration.phase = "copying";
          this.migration.message = "复制并校验分片；当前仍使用旧目录";
          for (const id of entries) {
            if (this.cancelMove) throw new Error("迁移已取消，继续使用旧目录");
            const data = await fs.readFile(path.join(from, id + ".bin"));
            const dest = path.join(staging, id + ".bin");
            await fs.writeFile(dest, data, { mode: 0o600 });
            if (
              digest((await fs.readFile(dest)).toString("base64")) !==
              digest(data.toString("base64"))
            )
              throw new Error("缓存复制校验失败");
            this.migration.completed++;
          }
          await fs.writeFile(
            path.join(staging, "index.json"),
            JSON.stringify(this.index),
            { mode: 0o600 },
          );
          if (this.cancelMove) throw new Error("迁移已取消，继续使用旧目录");
          for (const name of await fs.readdir(staging))
            await fs.rename(path.join(staging, name), path.join(to, name));
          await fs.rm(staging, { recursive: true });
          staging = "";
        }
        if (this.cancelMove) throw new Error("迁移已取消，继续使用旧目录");
        await this.saveConfig({
          cacheDirectory: to,
          pendingCacheDirectory: undefined,
          oldCacheDirectories: [
            ...new Set([
              ...(conf.oldCacheDirectories ?? []).filter((p) => p !== to),
              from,
            ]),
          ],
        });
        this.root = "";
        await this.load();
        this.migration = {
          ...this.migration,
          phase: "complete",
          message: "已切换目录；旧缓存保留，可在设置中单独清理。",
        };
      } catch (error) {
        this.migration = {
          ...this.migration,
          phase: this.cancelMove ? "cancelled" : "error",
          message: (error as Error).message,
        };
        throw error;
      } finally {
        if (staging) await fs.rm(staging, { recursive: true, force: true });
        this.moving = false;
      }
    });
  }
  async clearOld() {
    return this.serial(async () => {
      const conf = await this.load();
      for (const root of conf.oldCacheDirectories ?? []) {
        if (root === this.root) continue;
        if (
          (await fs.readFile(path.join(root, MARKER), "utf8")) !==
          "LibreTV Media Cache v1\n"
        )
          throw new Error("旧缓存标识不匹配，未执行清理");
        // Only known cache file types, never recursive deletion of a user-selected folder.
        for (const name of await fs.readdir(root))
          if (/^[a-f0-9]{64}\.bin$/.test(name) || name === "index.json")
            await fs.rm(path.join(root, name), { force: true });
      }
      await this.saveConfig({ oldCacheDirectories: [] });
    });
  }
}

declare global {
  var libreTVMediaCache: DiskMediaCache | undefined;
}
export function desktopDiskCache(): DiskMediaCache {
  const config = process.env.LIBRETV_DESKTOP_CONFIG;
  if (!config) throw new Error("桌面媒体缓存服务未启用");
  return (globalThis.libreTVMediaCache ??= new DiskMediaCache(config));
}
