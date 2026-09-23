import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createProductRetrieval } from "../src/server/products/index.ts";
import { normalizeProduct } from "../src/server/products/normalize.ts";
import { compareMatches, rankProduct } from "../src/server/products/rank.ts";
import { parseProductDetail, parseProducts } from "../src/server/ekt/validation.ts";
import { EktApiError } from "../src/server/ekt/errors.ts";
import type { ProductSource } from "../src/server/products/index.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const page1 = parseProducts(fixture("products-page-1"), 1);
const page2 = parseProducts(fixture("products-page-2"), 2);
const detail = parseProductDetail(fixture("product-515291"), 515291);
const summary = page2.items[0]!;

function setup(maxDetailRequests = 0, maxPages = 3, cacheTtlMs = 60_000) {
  const calls = { pages: [] as number[], details: [] as number[] };
  const source: ProductSource = {
    async getProducts(page) {
      calls.pages.push(page);
      return structuredClone(page === 1 ? page1 : page === 2 ? page2 : { page, per_page: 20, count: 0, items: [] });
    },
    async getProductById(id) {
      calls.details.push(id);
      assert.equal(id, 515291, "Only this detail fixture was observed");
      return structuredClone(detail);
    },
  };
  return { calls, source, retrieval: createProductRetrieval({ source, maxDetailRequests, maxPages, cacheTtlMs }) };
}

test("exact article lookup spans pages and preserves article punctuation", async () => {
  const { retrieval, calls } = setup();
  const found = await retrieval.findProductByArticle("  200300285_  ");
  assert.deepEqual(found.matches.map(m => m.product.id), [515291]);
  assert.equal(found.matches[0]?.matchedBy, "exact-article");
  assert.deepEqual(calls.pages, [1, 2]);
  assert.equal(found.coverage.catalogProducts, 40);
  assert.equal(found.coverage.catalogTermination, "match-found");
  assert.equal(found.coverage.catalogComplete, false);
  assert.equal(found.coverage.allScannedProductsDetailed, false);
  const variant = await retrieval.findProductByArticle("200300285");
  assert.equal(variant.matches[0]?.matchedBy, "article-variant");
  assert.equal(variant.matches[0]?.product.article, "200300285_");
  assert.equal(variant.coverage.catalogComplete, true);
});

test("partial article, case-insensitive names and reordered name tokens", async () => {
  const { retrieval } = setup();
  const partial = await retrieval.searchProducts("20030028");
  assert.ok(partial.matches.length > 1);
  assert.ok(partial.matches.every(m => m.matchedBy === "partial-article"));
  const name = await retrieval.searchProducts("drx250 mt");
  assert.ok(name.matches.some(m => m.product.id === 515291));
  assert.ok(name.matches.every(m => m.matchedBy === "name-phrase"));
  const tokens = await retrieval.searchProducts("legrand drx250 160а");
  assert.ok(tokens.matches.some(m => m.product.id === 515291 && m.matchedBy === "name-tokens"));
});

test("no results retain coverage rather than claiming global absence", async () => {
  const result = await setup().retrieval.searchProducts("a-product-that-does-not-exist");
  assert.deepEqual(result.matches, []);
  assert.equal(result.coverage.detailedProducts, 0);
});

test("detail normalization retains stock, properties, leading zeros and separate raw images", () => {
  const product = normalizeProduct(detail, summary);
  assert.equal(product.price, 64920);
  assert.equal(product.totalQuantity, 23);
  assert.equal(product.stockStatus, "positive");
  assert.equal(product.warehouses?.length, 24);
  assert.equal(product.warehouses?.find(s => s.name === "Алматы")?.quantity, 5);
  assert.equal(product.warehouses?.find(s => s.id === 2)?.quantity, 0);
  assert.equal(product.brand, "Legrand");
  assert.equal(product.supplierArticle, "027228");
  assert.equal(product.barcode, "3414970344526");
  assert.deepEqual(product.recommendationReferences, ["48783", "23466", "28727"]);
  assert.deepEqual(product.properties, detail.properties);
  assert.deepEqual(product.raw.detail, detail);
  assert.deepEqual(product.raw.catalog, summary);
  assert.notEqual(product.raw.catalog?.image, product.raw.detail?.image);
  assert.equal(product.image, detail.image);
  assert.equal(product.technicalCharacteristics.length, 5);
});

test("catalog products have unknown stock and missing detail fields despite empty offers", () => {
  const product = normalizeProduct(page1.items.find(p => p.image === null)!);
  assert.equal(product.image, null);
  assert.equal(product.totalQuantity, null);
  assert.equal(product.warehouses, null);
  assert.equal(product.stockStatus, "unknown");
  assert.equal(product.brand, null);
  assert.equal(product.description, null);
  assert.equal(product.supplierArticle, null);
  assert.equal(product.barcode, null);
  assert.deepEqual(product.technicalCharacteristics, []);
  assert.deepEqual(product.recommendationReferences, []);
  assert.equal(product.detailLoaded, false);
});

test("missing per-product properties stay missing, explicit zero stock is preserved", () => {
  // Synthetic variations of observed structure, not additional live observations.
  const product = normalizeProduct({ ...detail, properties: {}, quantity: 0, stores: [], image: null });
  assert.equal(product.totalQuantity, 0);
  assert.equal(product.stockStatus, "zero");
  assert.deepEqual(product.warehouses, []);
  assert.equal(product.brand, null);
  assert.deepEqual(product.conflicts, []);
  assert.deepEqual(product.technicalCharacteristics, []);
});

test("conflicting nominal current preserves all evidence without selecting a truth", () => {
  const product = normalizeProduct(detail);
  assert.equal(product.conflicts.length, 1);
  assert.equal(product.conflicts[0]?.field, "NOMINALNYY_TOK");
  assert.deepEqual(product.conflicts[0]?.evidence.map(e => [e.source, e.comparedValue]), [
    ["properties.NOMINALNYY_TOK", "250 A"], ["name", "160 A"], ["description", "160 A"],
  ]);
  assert.match(product.description!, /160А/);
  assert.equal(product.technicalCharacteristics.find(c => c.code === "NOMINALNYY_TOK")?.value, "250 А");
  assert.equal(product.technicalCharacteristics.find(c => c.code === "NOMINALNYY_TOK")?.conflictDetected, true);
  assert.equal(product.technicalCharacteristics.find(c => c.code === "NOMINALNOE_NAPRYAZHENIE")?.conflictDetected, false);
  const consistent = normalizeProduct({ ...detail, properties: { ...detail.properties, NOMINALNYY_TOK: "160 A" } });
  assert.deepEqual(consistent.conflicts, []); // 18kA is not mistaken for 18 A.
});

test("stock never comes from summing warehouses or interpreting offers", () => {
  const product = normalizeProduct({ ...detail, quantity: 0 });
  assert.equal(product.totalQuantity, 0);
  assert.equal(product.warehouses?.reduce((sum, s) => sum + s.quantity, 0), 23);
  assert.equal(product.stockStatus, "zero");
  assert.equal(normalizeProduct(summary).stockStatus, "unknown");
});

test("ranking tiers are deterministic with ID tie-breaks", () => {
  const base = normalizeProduct(detail);
  const candidates = [
    { ...base, id: 9, article: "XQUERYX", name: "Other", properties: {}, supplierArticle: null },
    { ...base, id: 8, article: "QUERY", name: "Other", properties: {}, supplierArticle: null },
    { ...base, id: 7, article: "other", name: "query", properties: {}, supplierArticle: null },
    { ...base, id: 6, article: "other", name: "A query product", properties: {}, supplierArticle: null },
    { ...base, id: 5, article: "other", name: "Other", description: "query", properties: {}, supplierArticle: null },
    { ...base, id: 4, article: "other", name: "Other", description: "query", properties: {}, supplierArticle: null },
  ];
  const rank = (items: typeof candidates) => items.flatMap(p => rankProduct(p, "query") ?? []).sort(compareMatches).map(m => m.product.id);
  assert.deepEqual(rank(candidates), [8, 9, 7, 6, 4, 5]);
  assert.deepEqual(rank([...candidates].reverse()), rank(candidates));
});

test("brand and textual properties are searchable when details are available", () => {
  const product = normalizeProduct(detail);
  assert.equal(rankProduct({ ...product, name: "Unbranded title" }, "legrand")?.matchedBy, "brand");
  assert.equal(rankProduct(product, "Винтовое")?.matchedBy, "text");
  assert.equal(rankProduct(product, "3414970344526")?.matchedBy, "text");
  assert.equal(rankProduct(product, "027228")?.matchedBy, "exact-article");
});

test("search enriches a likely candidate and searches its supplier article and technical properties", async () => {
  const { retrieval, calls } = setup(1);
  const result = await retrieval.findProductByArticle("200300285_");
  assert.equal(result.matches[0]?.product.detailLoaded, true);
  assert.deepEqual(calls.details, [515291]);
  assert.equal(result.coverage.detailedProducts, 1);
});

test("detail-only search works in a fully enriched scan and cache results cannot be mutated", async () => {
  let detailCalls = 0;
  const retrieval = createProductRetrieval({
    maxDetailRequests: 1,
    source: {
      async getProducts(page) { return { page, per_page: 20, count: page === 1 ? 1 : 0, items: page === 1 ? [summary] : [] }; },
      async getProductById() { detailCalls++; return detail; },
    },
  });
  const first = await retrieval.searchProducts("Винтовое");
  assert.equal(first.matches[0]?.product.id, 515291);
  assert.equal(first.coverage.allScannedProductsDetailed, true);
  first.matches[0]!.product.properties.NOMINALNYY_TOK = "tampered";
  assert.equal((await retrieval.findProductByArticle("027228")).matches[0]?.product.properties.NOMINALNYY_TOK, "250 А");
  assert.equal(detailCalls, 1);
});

test("fresh ID lookup bypasses catalog and always fetches detail", async () => {
  const { retrieval, calls } = setup();
  await retrieval.getNormalizedProductById(515291);
  await retrieval.getNormalizedProductById(515291);
  assert.deepEqual(calls.pages, []);
  assert.deepEqual(calls.details, [515291, 515291]);
});

test("fresh ID detail becomes searchable in an existing catalog snapshot", async () => {
  const { retrieval } = setup();
  assert.equal((await retrieval.searchProducts("Винтовое")).matches.length, 0);
  await retrieval.getNormalizedProductById(515291);
  assert.equal((await retrieval.searchProducts("Винтовое")).matches[0]?.product.id, 515291);
});

test("concurrent searches share catalog and candidate detail requests", async () => {
  const { retrieval, calls } = setup(1);
  const [first, second] = await Promise.all([
    retrieval.searchProducts(summary.article), retrieval.searchProducts(summary.article),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(calls.pages, [1, 2, 3]);
  assert.deepEqual(calls.details, [515291]);
});

test("page limit is explicit; expiry reloads catalog", async () => {
  const { retrieval, calls } = setup(0, 1, 0);
  const result = await retrieval.searchProducts("legrand");
  assert.equal(result.coverage.catalogTermination, "page-limit");
  assert.equal(result.coverage.catalogProducts, 20);
  await retrieval.searchProducts("legrand");
  assert.deepEqual(calls.pages, [1, 1]);
});

test("duplicate articles return all exact matches instead of selecting one", async () => {
  const retrieval = createProductRetrieval({ maxDetailRequests: 0, source: {
    async getProducts() { return { page: 1, per_page: 20, count: 2, items: [summary, { ...summary, id: 123 }] }; },
    async getProductById() { throw new Error("Not needed"); },
  } });
  assert.deepEqual((await retrieval.findProductByArticle(summary.article)).matches.map(m => m.product.id), [123, 515291]);
});

test("API failures propagate rather than being converted into no results", async () => {
  const error = new EktApiError("AUTHENTICATION", "EKT API authentication failed.", 401);
  const retrieval = createProductRetrieval({ source: {
    async getProducts() { throw error; }, async getProductById() { throw error; },
  } });
  await assert.rejects(retrieval.searchProducts("legrand"), e => e === error);
  await assert.rejects(retrieval.getNormalizedProductById(515291), e => e === error);
  const { source } = setup();
  source.getProductById = async () => { throw error; };
  await assert.rejects(createProductRetrieval({ source, maxDetailRequests: 1 }).searchProducts(summary.article), e => e === error);
});

test("repeated pages fail rather than looping or implying a complete catalog", async () => {
  const { source } = setup();
  source.getProducts = async page => ({ ...page1, page });
  await assert.rejects(createProductRetrieval({ source }).searchProducts("legrand"), { code: "MALFORMED_RESPONSE" });
});

test("rejects invalid inputs before network requests", async () => {
  const { retrieval, calls } = setup();
  for (const query of ["", "  ", "x".repeat(501)]) {
    await assert.rejects(retrieval.searchProducts(query), { code: "INVALID_ARGUMENT" });
    await assert.rejects(retrieval.findProductByArticle(query), { code: "INVALID_ARGUMENT" });
  }
  for (const id of [0, -1, NaN, 1.5]) await assert.rejects(retrieval.getNormalizedProductById(id), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(calls, { pages: [], details: [] });
  assert.throws(() => createProductRetrieval({ maxPages: 0 }), { code: "INVALID_ARGUMENT" });
});
