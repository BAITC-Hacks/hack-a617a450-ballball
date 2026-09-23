import { mkdir, open, readFile, rename, unlink, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createCatalogLoader, indexProduct } from "./catalog.ts";
import type { CatalogState, ProductSource } from "./catalog.ts";
import { normalizeProduct } from "./normalize.ts";
import { parseProducts } from "../ekt/validation.ts";
import { EktApiError } from "../ekt/errors.ts";

export const defaultCatalogPath = resolve(".ekt-cache/catalog.json");
// Promise sharing also covers different retrieval instances in one process.
const builds = new Map<string, Promise<CatalogState>>();
type DiskItem = { id: number; article: string; name: string; price: number; image: string | null; url: string; url_api_detail: string };
interface Snapshot { version: 1; fetchedAt: string; pages: number; endReason: "empty-page" | "short-page-wrap"; items: DiskItem[] }

export function createPersistentCatalog(source: ProductSource, path: string, ttl: number) {
  path = resolve(path);
  let current: CatalogState | undefined;
  let refresh: Promise<CatalogState> | undefined;
  let retryAfter = 0;
  let lastError: string | undefined;
  let nextDiskCheck = 0;

  async function read(): Promise<CatalogState | undefined> {
    try {
      if ((await stat(path)).size > 50_000_000) return undefined;
      const disk = JSON.parse(await readFile(path, "utf8")) as Snapshot;
      if (disk.version !== 1 || !Number.isSafeInteger(disk.pages) || disk.pages < 1 ||
        !["empty-page", "short-page-wrap"].includes(disk.endReason) ||
        !Number.isFinite(Date.parse(disk.fetchedAt)) || Date.parse(disk.fetchedAt) > Date.now() + 60_000 || !Array.isArray(disk.items)) return undefined;
      const parsed = parseProducts({ page: 1, per_page: Math.max(1, disk.items.length), count: disk.items.length,
        items: disk.items.map(i => ({ id: i.id, article: i.article, name: i.name, price: i.price, image: i.image, url: i.url, url_api_detail: i.url_api_detail, offers: [] })) }, 1);
      if (new Set(parsed.items.map(i => i.id)).size !== parsed.items.length) return undefined;
      const reader = createCatalogLoader(source, ttl);
      const state = reader.acquire();
      for (const item of parsed.items) { state.summaries.set(item.id, item); indexProduct(state, normalizeProduct(item)); }
      Object.assign(state, { pages: disk.pages, complete: true, endReason: disk.endReason, fetchedAt: disk.fetchedAt,
        expiresAt: Date.parse(disk.fetchedAt) + ttl, cacheLayer: "persistent" });
      reader.release(state);
      return state;
    } catch { return undefined; }
  }

  // Read local data when the instance starts; this never initiates network work.
  const ready = read().then(state => { current = state; });

  async function build(): Promise<CatalogState> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch {
      // A live process owns the refresh. Never duplicate its API scan.
      try {
        const pid = Number(await readFile(lockPath, "utf8"));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new EktApiError("CACHE_BUSY", "Catalog refresh is already running.");
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            await unlink(lockPath);
            return build();
          }
        }
      } catch (error) { if (error instanceof EktApiError) throw error; }
      throw new EktApiError("CACHE_BUSY", "Catalog refresh is already running.");
    }
    await lock.writeFile(String(process.pid));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const builder = createCatalogLoader(source, ttl);
      const state = builder.acquire();
      try { while (!state.complete) await builder.next(state, 0); }
      finally { builder.release(state); }
      const snapshot: Snapshot = {
        version: 1, fetchedAt: state.fetchedAt, pages: state.pages, endReason: state.endReason,
        // Explicit whitelist: no offers, quantities, detail snapshots, arbitrary
        // API fields, environment values, credentials, or authorization headers.
        items: [...state.summaries.values()].map(p => ({ id: p.id, article: p.article, name: p.name,
          price: p.price, image: p.image, url: p.url, url_api_detail: p.url_api_detail })),
      };
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(snapshot)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      state.cacheLayer = "memory";
      return state;
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  function refreshCatalog(): Promise<CatalogState> {
    if (refresh) return refresh;
    const shared = builds.get(path) ?? build();
    builds.set(path, shared);
    refresh = shared.then(state => {
      current = state; lastError = undefined; retryAfter = 0;
      return state;
    }).catch(error => {
      lastError = error instanceof EktApiError ? error.code : "CACHE_IO";
      retryAfter = Date.now() + 60_000;
      throw error instanceof EktApiError ? error : new EktApiError("CACHE_IO", "Catalog cache refresh failed.");
    }).finally(() => { if (builds.get(path) === shared) builds.delete(path); refresh = undefined; });
    return refresh;
  }

  return {
    async initialize() { await ready; return { available: Boolean(current), cacheLayer: current?.cacheLayer, products: current?.products.size ?? 0 }; },
    async acquire() {
      await ready;
      if (!current || Date.now() >= current.expiresAt) {
        // Reload an index replaced by another process before starting any refresh.
        if (!refresh && Date.now() >= nextDiskCheck) {
          nextDiskCheck = Date.now() + 5_000;
          const disk = await read();
          if (disk && (!current || Date.parse(disk.fetchedAt) > Date.parse(current.fetchedAt))) current = disk;
        }
        if ((!current || Date.now() >= current.expiresAt) && Date.now() >= retryAfter) void refreshCatalog().catch(() => {});
      }
      if (!current) throw new EktApiError("CATALOG_NOT_READY", "Catalog is warming. Run npm run catalog:refresh or retry shortly.");
      current.users++;
      return current;
    },
    release(state: CatalogState) { state.users--; state.cacheLayer = "memory"; },
    peek() { return current; },
    async refreshCatalog() { await ready; return refreshCatalog(); },
    status() { return { refreshing: Boolean(refresh), error: lastError }; },
  };
}
