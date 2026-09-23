// Importing the EKT client enforces the Node/server boundary.
import { getProducts, getProductById } from "../ekt/client.ts";
import { EktApiError } from "../ekt/errors.ts";
import { createCatalogLoader, coverageFor, indexProduct } from "./catalog.ts";
import type { ProductSource, CatalogState } from "./catalog.ts";
import { createPersistentCatalog, defaultCatalogPath } from "./persistent.ts";
export type { ProductSource } from "./catalog.ts";
export { CatalogLoadError } from "./catalog.ts";
import { normalizeProduct } from "./normalize.ts";
import { normalizeSearchText, rankProduct, compareMatches } from "./rank.ts";
import type { Product, ProductSearchResult, SearchCoverage } from "./types.ts";
export type { Product, TechnicalCharacteristic, ProductConflict, ProductSearchResult, SearchCoverage } from "./types.ts";

export interface RetrievalOptions {
  /** Optional general-search cap only; default is unlimited. Exact lookup ignores it. */
  maxPages?: number;
  /** Defaults to zero with persistence (fast discovery), otherwise 20. */
  maxDetailRequests?: number;
  /** Persistent discovery is stale after 24 hours; in-memory-only mode uses 5 minutes. */
  cacheTtlMs?: number;
  source?: ProductSource;
  /** false disables persistence. Injected test sources default to false. */
  cachePath?: string | false;
}

export function createProductRetrieval(options: RetrievalOptions = {}) {
  const source = options.source ?? { getProducts, getProductById };
  const maxPages = options.maxPages ?? Infinity;
  const cachePath = options.cachePath ?? (options.source ? false : defaultCatalogPath);
  const maxDetails = options.maxDetailRequests ?? (cachePath ? 0 : 20);
  const ttl = options.cacheTtlMs ?? (cachePath ? 24 * 60 * 60_000 : 300_000);
  for (const [value, minimum] of [[options.maxPages ?? 1, 1], [maxDetails, 0], [ttl, 0]] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new EktApiError("INVALID_ARGUMENT", "Invalid retrieval limits.");
  }
  const loader = createCatalogLoader(source, ttl);
  const persistent = cachePath ? createPersistentCatalog(source, cachePath, ttl) : undefined;

  async function enrich(state: CatalogState, id: number): Promise<Product> {
    const existing = state.products.get(id);
    if (existing?.detailLoaded) return existing;
    let pending = state.pendingDetails.get(id);
    if (!pending) {
      pending = source.getProductById(id).then(detail => {
        const product = normalizeProduct(detail, state.summaries.get(id));
        indexProduct(state, product);
        return product;
      }).finally(() => { state.pendingDetails.delete(id); });
      state.pendingDetails.set(id, pending);
    }
    return pending;
  }

  function validateQuery(query: string): string {
    if (typeof query !== "string" || !normalizeSearchText(query) || query.length > 500) {
      throw new EktApiError("INVALID_ARGUMENT", "Search text must contain 1 to 500 characters and not be blank.");
    }
    return normalizeSearchText(query);
  }

  async function run(query: string, exact: boolean): Promise<ProductSearchResult> {
    const q = validateQuery(query);
    const state = persistent ? await persistent.acquire() : loader.acquire();
    const startPages = state.pages;
    const hasExact = () => state.articles.has(q);
    try {
      while (!state.complete && !(exact && hasExact()) && (exact || state.pages < maxPages)) {
        await loader.next(state, startPages);
      }
      // Enrichment is separate from full summary coverage. Detail-only article
      // fields cannot be declared globally searched until all details are loaded.
      const candidates = maxDetails === 0 ? [] : [...state.products.values()].filter(p => !p.detailLoaded && (!exact || rankProduct(p, q)?.matchedBy === "exact-article"))
        .sort((a, b) => (rankProduct(b, q)?.score ?? 0) - (rankProduct(a, q)?.score ?? 0) || a.id - b.id);
      for (const product of candidates.slice(0, maxDetails)) await enrich(state, product.id);
      const pool = exact ? [...(state.articles.get(q) ?? [])].map(id => state.products.get(id)!) : [...state.products.values()];
      let matches = pool.flatMap(product => {
        const match = rankProduct(product, q);
        return match && (!exact || match.matchedBy === "exact-article") ? [match] : [];
      }).sort(compareMatches);
      // EKT actually supplies numeric articles ending in '_'. This is a
      // labeled candidate fallback, not an assertion that the raw articles equal.
      if (exact && matches.length === 0 && state.complete && /^\d+$/.test(q)) {
        matches = [...(state.articles.get(`${q}_`) ?? [])].map(id => state.products.get(id)!).filter(p => normalizeSearchText(p.article) === `${q}_`)
          .map(product => ({ product, score: 650, matchedBy: "article-variant" as const })).sort(compareMatches);
      }
      const status = persistent?.status();
      return structuredClone({ query, matches, coverage: { ...coverageFor(state, startPages, exact && hasExact() ? "match-found" : "page-limit"),
        ...(status ? { refreshing: status.refreshing, refreshError: status.error } : {}) } });
    } finally { if (persistent) persistent.release(state); else loader.release(state); }
  }

  const searchProducts = (query: string) => run(query, false);
  return {
    initialize: async () => persistent ? persistent.initialize() : { available: false, products: 0 },
    async refreshCatalog() {
      if (!persistent) throw new EktApiError("CONFIGURATION", "Persistent cache is disabled.");
      const state = await persistent.refreshCatalog();
      return { ...coverageFor(state, 0, state.endReason), cacheLayer: "network" as const };
    },
    searchProducts,
    /** Stops at an exact match; returns all matching IDs loaded so far. */
    findProductByArticle: (article: string) => run(article, true),
    /** Always fetch fresh detail; this call never scans the catalog. */
    async getNormalizedProductById(id: number): Promise<Product> {
      if (!Number.isSafeInteger(id) || id < 1) throw new EktApiError("INVALID_ARGUMENT", "Product ID must be a positive safe integer.");
      const detail = await source.getProductById(id);
      const state = persistent?.peek() ?? loader.peek();
      const product = normalizeProduct(detail, state?.summaries.get(id));
      // A fresh lookup can enrich an existing scanned item for subsequent search.
      if (state?.summaries.has(id)) indexProduct(state, structuredClone(product));
      return product;
    },
  };
}

const retrieval = createProductRetrieval();
export const searchProducts = retrieval.searchProducts;
export const findProductByArticle = retrieval.findProductByArticle;
export const getNormalizedProductById = retrieval.getNormalizedProductById;
export const initializeCatalog = retrieval.initialize;
export const refreshCatalog = retrieval.refreshCatalog;
