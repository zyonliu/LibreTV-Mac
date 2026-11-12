"use client";
import { useEffect } from "react";
import { isDesktop } from "@/lib/desktop/bridge";
import { db } from "@/lib/db";
import { useAppStore } from "@/lib/store";
import { flushPendingPersist } from "@/lib/persist-storage";
import { useRouter } from "next/navigation";

export function DesktopRuntime() {
  const router = useRouter();
  useEffect(() => {
    if (!isDesktop()) return;
    const host = window as unknown as {
      __ltDesktopNavigate?: (url: string) => void;
      __ltDesktopBackup?: () => Promise<unknown>;
      __ltDesktopRestore?: (value: {
        schema: number;
        tables: Record<string, unknown[]>;
        local: Record<string, string>;
      }) => Promise<boolean>;
    };
    host.__ltDesktopNavigate = url => router.push(url);
    host.__ltDesktopBackup = async () => {
      flushPendingPersist();
      const tables: Record<string, unknown[]> = {};
      for (const table of db.tables) tables[table.name] = await table.toArray();
      const local: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (key.startsWith("libretv") || key.startsWith("desktop-"))
          local[key] = localStorage.getItem(key)!;
      }
      return { schema: 3, tables, local };
    };
    host.__ltDesktopRestore = async (snapshot) => {
      if (snapshot.schema !== 3 || !snapshot.tables || !snapshot.local)
        throw new Error("备份数据结构不兼容");
      for (const table of db.tables)
        if (!Array.isArray(snapshot.tables[table.name]))
          throw new Error(`备份缺少数据表：${table.name}`);
      flushPendingPersist();
      await db.transaction("rw", db.tables, async () => {
        for (const table of db.tables) {
          await table.clear();
          const values = snapshot.tables[table.name] ?? [];
          if (values.length) await table.bulkPut(values);
        }
      });
      for (const key of Object.keys(localStorage))
        if (key.startsWith("libretv") || key.startsWith("desktop-"))
          localStorage.removeItem(key);
      for (const [key, value] of Object.entries(snapshot.local))
        if (key.startsWith("libretv") || key.startsWith("desktop-"))
          localStorage.setItem(key, value);
      await useAppStore.persist.rehydrate();
      return true;
    };
    const pause = () => flushPendingPersist();
    window.addEventListener("libretv:desktop-pause", pause);
    return () => {
      delete host.__ltDesktopBackup;
      delete host.__ltDesktopRestore;
      delete host.__ltDesktopNavigate;
      window.removeEventListener("libretv:desktop-pause", pause);
    };
  }, [router]);
  return null;
}
