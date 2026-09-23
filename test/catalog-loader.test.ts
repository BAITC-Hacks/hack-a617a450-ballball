import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createProductRetrieval, CatalogLoadError } from '../src/server/products/index.ts';
import type { ProductSource } from '../src/server/products/index.ts';
import { parseProductDetail, parseProducts } from '../src/server/ekt/validation.ts';
import { EktApiError } from '../src/server/ekt/errors.ts';

const raw = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const base = parseProducts(raw('products-page-1'), 1).items[0]!;
const detail = parseProductDetail(raw('product-515291'), 515291);
// Synthetic pagination with the observed API envelope; no invented production data.
function catalog(lastPage = 13, targetPage = 12) {
  const pages: number[] = [];
  const details: number[] = [];
  const source: ProductSource = {
    async getProducts(page) {
      pages.push(page);
      return { page, per_page: 1, count: page <= lastPage ? 1 : 0,
        items: page <= lastPage ? [{ ...base, id: page, article: page === targetPage ? 'TARGET' : `ARTICLE-${page}`, name: `Product ${page}` }] : [] };
    },
    async getProductById(id) { details.push(id); return { ...detail, quantity: details.length }; },
  };
  return { source, pages, details };
}

test('exact lookup finds beyond page 10 and stops without fetching the rest, ignoring optional general-search cap', async () => {
  const c = catalog();
  const api = createProductRetrieval({ source: c.source, maxDetailRequests: 0, maxPages: 2 });
  const r = await api.findProductByArticle('TARGET');
  assert.equal(r.matches[0]?.product.id, 12);
  assert.equal(c.pages.length, 12);
  assert.equal(r.coverage.catalogComplete, false);
  assert.equal(r.coverage.catalogTermination, 'match-found');
  assert.equal(r.coverage.nextPage, 13);
  const cached = await api.findProductByArticle('TARGET');
  assert.equal(cached.coverage.catalogSource, 'cached');
  assert.equal(cached.coverage.pagesFetched, 0);
  assert.equal(c.pages.length, 12);
});

test('general search resumes early-stopped scan then caches the entire catalog', async () => {
  const c = catalog();
  const api = createProductRetrieval({ source: c.source, maxDetailRequests: 0 });
  await api.findProductByArticle('ARTICLE-2');
  const all = await api.searchProducts('Product');
  assert.equal(all.matches.length, 13);
  assert.equal(all.coverage.catalogPages, 14);
  assert.equal(all.coverage.catalogComplete, true);
  assert.equal(all.coverage.catalogSource, 'mixed');
  assert.equal(all.coverage.nextPage, null);
  const again = await api.searchProducts('Product');
  assert.equal(again.coverage.catalogSource, 'cached');
  assert.equal(c.pages.length, 14);
  assert.deepEqual(c.pages, Array.from({ length: 14 }, (_, i) => i + 1));
});

test('no result is complete only after an empty API page, and cached misses make no calls', async () => {
  const c = catalog();
  const api = createProductRetrieval({ source: c.source, maxDetailRequests: 0 });
  const r = await api.findProductByArticle('DOES-NOT-EXIST');
  assert.deepEqual(r.matches, []);
  assert.equal(r.coverage.catalogComplete, true);
  assert.equal(r.coverage.catalogTermination, 'empty-page');
  assert.equal(r.coverage.catalogProducts, 13);
  await api.findProductByArticle('ALSO-MISSING');
  assert.equal(c.pages.length, 14);
});

test('pagination uses actual counts, continues beyond short pages and tolerates changing per_page', async () => {
  const c = catalog(3, 3);
  const original = c.source.getProducts;
  c.source.getProducts = async page => ({ ...await original(page), per_page: page === 1 ? 20 : 2 });
  const result = await createProductRetrieval({ source: c.source, maxDetailRequests: 0 }).searchProducts('Product');
  assert.equal(result.matches.length, 3);
  assert.deepEqual(c.pages, [1, 2, 3, 4]);
  assert.equal(result.coverage.catalogComplete, true);
});

test('partway failure carries incomplete coverage, retains good pages and retries only failed page', async () => {
  const c = catalog(4, 4);
  let fail = true;
  const original = c.source.getProducts;
  c.source.getProducts = async page => {
    if (page === 3 && fail) { c.pages.push(page); throw new EktApiError('NETWORK', 'Must not be exposed'); }
    return original(page);
  };
  const api = createProductRetrieval({ source: c.source, maxDetailRequests: 0 });
  await assert.rejects(api.findProductByArticle('TARGET'), error => {
    assert.ok(error instanceof CatalogLoadError);
    assert.equal(error.coverage.catalogComplete, false);
    assert.equal(error.coverage.catalogProducts, 2);
    assert.equal(error.coverage.nextPage, 3);
    assert.equal(error.coverage.catalogTermination, 'error');
    assert.doesNotMatch(error.message, /Must not be exposed/);
    return true;
  });
  fail = false;
  const found = await api.findProductByArticle('TARGET');
  assert.equal(found.matches[0]?.product.id, 4);
  assert.deepEqual(c.pages, [1, 2, 3, 3, 4]);
  assert.equal(found.coverage.catalogSource, 'mixed');
});

test('concurrent full scans and exact lookup share page requests and preserve early stopping', async () => {
  const c = catalog();
  const api = createProductRetrieval({ source: c.source, maxDetailRequests: 0 });
  const [first, exact, second] = await Promise.all([
    api.searchProducts('Product'), api.findProductByArticle('ARTICLE-2'), api.searchProducts('Product'),
  ]);
  assert.equal(first.matches.length, 13);
  assert.equal(second.matches.length, 13);
  assert.equal(exact.matches[0]?.product.id, 2);
  assert.ok(exact.coverage.catalogPages < 14);
  assert.deepEqual(c.pages, Array.from({ length: 14 }, (_, i) => i + 1));
});

test('fresh detail always calls EKT despite a complete cached catalog', async () => {
  const c = catalog(1);
  const api = createProductRetrieval({ source: c.source, maxDetailRequests: 0 });
  await api.searchProducts('Product');
  assert.equal((await api.getNormalizedProductById(515291)).totalQuantity, 1);
  assert.equal((await api.getNormalizedProductById(515291)).totalQuantity, 2);
  assert.deepEqual(c.details, [515291, 515291]);
  assert.deepEqual(c.pages, [1, 2]);
});

test('real numeric trailing-underscore article is labeled only after complete exact scan', async () => {
  const p1 = parseProducts(raw('products-page-1'), 1);
  const api = createProductRetrieval({ maxDetailRequests: 0, source: {
    async getProducts(page) { return page === 1 ? p1 : { page, per_page: 20, count: 0, items: [] }; },
    async getProductById() { throw new Error('No detail needed'); },
  } });
  const result = await api.findProductByArticle('200300283');
  assert.equal(result.matches[0]?.product.id, 515289);
  assert.equal(result.matches[0]?.product.article, '200300283_');
  assert.equal(result.matches[0]?.matchedBy, 'article-variant');
  assert.equal(result.coverage.catalogComplete, true);
});

test('literal article on a later page wins over a trailing-underscore candidate', async () => {
  const api = createProductRetrieval({ maxDetailRequests: 0, source: {
    async getProducts(page) { return { page, per_page: 1, count: 1, items: [{ ...base, id: page, article: page === 1 ? '123_' : '123' }] }; },
    async getProductById() { throw new Error('No detail needed'); },
  } });
  const result = await api.findProductByArticle('123');
  assert.equal(result.matches[0]?.product.id, 2);
  assert.equal(result.matches[0]?.matchedBy, 'exact-article');
});

test('observed live EKT short final page followed by a first-page wrap confirms completion', async () => {
  const first = parseProducts(raw('products-page-1'), 1);
  const last = parseProducts(raw('end-page-752'), 752);
  const wrapped = parseProducts(raw('end-page-753'), 753);
  const pages: number[] = [];
  const api = createProductRetrieval({ maxDetailRequests: 0, source: {
    async getProducts(page) {
      pages.push(page);
      // Replay boundary structure compactly, retaining exact observed items/counts.
      return page === 1 ? first : page === 2 ? { ...last, page } : { ...wrapped, page };
    },
    async getProductById() { throw new Error('No detail needed'); },
  } });
  const found = await api.findProductByArticle('200300283');
  assert.equal(found.coverage.catalogComplete, true);
  assert.equal(found.coverage.catalogTermination, 'short-page-wrap');
  assert.equal(found.coverage.catalogProducts, 37);
  assert.equal(found.matches[0]?.product.id, 515289);
  assert.equal(found.matches[0]?.product.article, '200300283_');
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal((await api.findProductByArticle('absent')).coverage.catalogSource, 'cached');
  assert.deepEqual(pages, [1, 2, 3]);
});
