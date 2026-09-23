import { EktApiError } from "../ekt/errors.ts";
import type { EktProductDetail, EktProductsResponse, EktProductSummary } from "../ekt/types.ts";
import { normalizeProduct } from "./normalize.ts";
import { normalizeSearchText } from "./rank.ts";
import type { Product, SearchCoverage } from "./types.ts";

export interface ProductSource {
  getProducts(page: number): Promise<EktProductsResponse>;
  getProductById(id: number): Promise<EktProductDetail>;
}
export interface CatalogState {
  summaries: Map<number, EktProductSummary>;
  products: Map<number, Product>;
  articles: Map<string, Set<number>>;
  pendingDetails: Map<number, Promise<Product>>;
  pages: number;
  complete: boolean;
  endReason: "empty-page" | "short-page-wrap";
  firstPageIds: number[];
  lastPageWasShort: boolean;
  fetchedAt: string;
  expiresAt: number;
  users: number;
  pendingPage?: Promise<void>;
  cacheLayer?: "memory" | "persistent" | "network";
}

export function indexProduct(state: CatalogState, product: Product): void {
  const keys = (p: Product) => [p.article, p.supplierArticle, p.properties.CML2_ARTICLE]
    .filter((s): s is string => typeof s === "string" && s.length > 0).map(normalizeSearchText);
  const old = state.products.get(product.id);
  for (const key of old ? keys(old) : []) {
    const ids = state.articles.get(key);
    ids?.delete(product.id);
    if (ids?.size === 0) state.articles.delete(key);
  }
  state.products.set(product.id, product);
  for (const key of keys(product)) {
    const ids = state.articles.get(key) ?? new Set<number>();
    ids.add(product.id);
    state.articles.set(key, ids);
  }
}

export function coverageFor(state: CatalogState, startPages: number, termination: SearchCoverage["catalogTermination"]): SearchCoverage {
  const detailedProducts = [...state.products.values()].filter(p => p.detailLoaded).length;
  return {
    catalogPages: state.pages, catalogProducts: state.products.size,
    catalogTermination: state.complete ? state.endReason : termination,
    catalogComplete: state.complete,
    catalogSource: startPages === state.pages ? "cached" : startPages > 0 ? "mixed" : "network",
    pagesFetched: state.pages - startPages,
    nextPage: state.complete ? null : state.pages + 1,
    catalogFetchedAt: state.fetchedAt, detailedProducts,
    allScannedProductsDetailed: detailedProducts === state.products.size,
    ...(state.cacheLayer ? { cacheLayer: state.cacheLayer, catalogStale: Date.now() >= state.expiresAt } : {}),
  };
}

/** Contains only safe error metadata and observed scan coverage, never raw errors. */
export class CatalogLoadError extends EktApiError {
  readonly coverage: SearchCoverage;
  constructor(error: unknown, coverage: SearchCoverage) {
    super(error instanceof EktApiError ? error.code : "NETWORK", "EKT catalog scan failed before completion; retry to resume.", error instanceof EktApiError ? error.status : undefined);
    this.coverage = coverage;
  }
}

/** One shared progressive scan per credential-scoped retrieval instance. */
export function createCatalogLoader(source: ProductSource, ttl: number) {
  let current: CatalogState | undefined;
  function acquire(): CatalogState {
    if (!current || (current.users === 0 && !current.pendingPage && Date.now() >= current.expiresAt)) {
      current = { summaries: new Map(), products: new Map(), articles: new Map(), pendingDetails: new Map(), pages: 0,
        complete: false, endReason: "empty-page", firstPageIds: [], lastPageWasShort: false,
        fetchedAt: new Date().toISOString(), expiresAt: Date.now() + ttl, users: 0 };
    }
    current.users++;
    return current;
  }
  async function next(state: CatalogState, startPages: number): Promise<void> {
    if (state.complete) return;
    if (!state.pendingPage) {
      state.pendingPage = (async () => {
        const page = state.pages + 1;
        const result = await source.getProducts(page);
        // Client validates the wire schema. Also protect pagination for injected adapters.
        if (result.page !== page || result.count !== result.items.length || result.per_page < 1 || result.count > result.per_page) {
          throw new EktApiError("MALFORMED_RESPONSE", "Inconsistent EKT pagination metadata.");
        }
        const added = result.items.filter(item => !state.summaries.has(item.id));
        // Observed live: a short final page is followed by page-1 products,
        // although EKT echoes the requested (out-of-range) page number.
        const wrappedAfterShortPage = result.count > 0 && added.length === 0 && state.lastPageWasShort &&
          result.items.length === state.firstPageIds.length && result.items.every((item, i) => item.id === state.firstPageIds[i]);
        if (result.count > 0 && added.length === 0 && !wrappedAfterShortPage) throw new EktApiError("MALFORMED_RESPONSE", "EKT pagination returned no new products.");
        // Commit a whole page only after it is checked. Failures retry this same page.
        for (const item of added) {
          state.summaries.set(item.id, structuredClone(item));
          indexProduct(state, normalizeProduct(item));
        }
        state.pages = page;
        if (page === 1) state.firstPageIds = result.items.map(item => item.id);
        // Actual API has page/per_page/count/items, no total or next-page pointer.
        // Probe beyond short pages; empty or the observed short-page wrap ends it.
        state.complete = result.count === 0 || wrappedAfterShortPage;
        state.endReason = wrappedAfterShortPage ? "short-page-wrap" : "empty-page";
        state.lastPageWasShort = result.count < result.per_page;
        state.fetchedAt = new Date().toISOString();
        state.expiresAt = Date.now() + ttl;
      })().finally(() => { state.pendingPage = undefined; });
    }
    try { await state.pendingPage; }
    catch (error) {
      if (state.pages === 0) throw error;
      throw new CatalogLoadError(error, coverageFor(state, startPages, "error"));
    }
  }
  return {
    acquire, next,
    release(state: CatalogState) { state.users--; },
    peek() { return current && Date.now() < current.expiresAt ? current : undefined; },
  };
}
