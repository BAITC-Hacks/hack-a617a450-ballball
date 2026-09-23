import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProductRetrieval } from '../src/server/products/index.ts';
import type { ProductSource } from '../src/server/products/index.ts';
import { parseProducts, parseProductDetail } from '../src/server/ekt/validation.ts';
import { EktApiError } from '../src/server/ekt/errors.ts';

const first = parseProducts(JSON.parse(readFileSync(new URL('./fixtures/products-page-1.json', import.meta.url), 'utf8')), 1);
const product = first.items.find(p => p.article === '200300283_')!;
const detail = parseProductDetail(JSON.parse(readFileSync(new URL('./fixtures/product-515291.json', import.meta.url), 'utf8')), 515291);
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'ekt-cache-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, 'catalog.json');
  const calls = { pages: 0, details: 0 };
  const source: ProductSource = {
    async getProducts(page) {
      calls.pages++;
      return { page, per_page: 20, count: page === 1 ? 1 : 0, items: page === 1 ? [product] : [] };
    },
    async getProductById(id) { calls.details++; return { ...detail, id, quantity: calls.details }; },
  };
  return { cachePath, calls, source };
}

test('completed cache is created atomically with only allowlisted discovery fields', async t => {
  const s = await setup(t);
  const original = s.source.getProducts;
  s.source.getProducts = async page => {
    const result = await original(page);
    return { ...result, items: result.items.map(p => ({ ...p, quantity: 999, stores: [{ quantity: 999 }], authorization: 'not-persisted', offers: [{ private: 'not-persisted' }] })) };
  };
  await createProductRetrieval(s).refreshCatalog();
  const text = await readFile(s.cachePath, 'utf8');
  assert.doesNotMatch(text, /authorization|not-persisted|quantity|stores|offers/);
  const disk = JSON.parse(text);
  assert.equal(disk.version, 1);
  assert.equal(disk.items.length, 1);
  assert.equal(disk.items[0].article, '200300283_');
  assert.equal((await stat(s.cachePath)).mode & 0o777, 0o600);
});

test('simulated process restart loads the persisted index and searches without any EKT calls', async t => {
  const s = await setup(t);
  await createProductRetrieval(s).refreshCatalog();
  s.calls.pages = 0;
  const restarted = createProductRetrieval(s);
  assert.equal((await restarted.initialize()).available, true);
  const firstResult = await restarted.findProductByArticle('200300283');
  assert.equal(firstResult.matches[0]?.product.id, product.id);
  assert.equal(firstResult.matches[0]?.matchedBy, 'article-variant');
  assert.equal(firstResult.coverage.cacheLayer, 'persistent');
  assert.equal(firstResult.coverage.catalogStale, false);
  const second = await restarted.findProductByArticle('200300283_');
  assert.equal(second.coverage.cacheLayer, 'memory');
  assert.equal(second.matches[0]?.matchedBy, 'exact-article');
  assert.ok((await restarted.searchProducts('Legrand')).matches.length);
  assert.deepEqual(s.calls, { pages: 0, details: 0 });
});

test('stale index serves immediately while refresh is blocked, then swaps in the replacement', async t => {
  const s = await setup(t);
  await createProductRetrieval(s).refreshCatalog();
  const disk = JSON.parse(await readFile(s.cachePath, 'utf8'));
  disk.fetchedAt = '2020-01-01T00:00:00Z';
  await writeFile(s.cachePath, JSON.stringify(disk));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = s.source.getProducts;
  s.source.getProducts = async page => { await blocked; return original(page); };
  const restarted = createProductRetrieval(s);
  const result = await restarted.findProductByArticle('200300283');
  assert.equal(result.matches[0]?.product.id, product.id);
  assert.equal(result.coverage.catalogStale, true);
  assert.equal(result.coverage.refreshing, true);
  // If discovery waited on the refresh, the await above could not complete.
  release();
  await restarted.refreshCatalog();
  assert.equal((await restarted.findProductByArticle('200300283')).coverage.catalogStale, false);
});

test('explicit refresh does not block an ordinary search against a usable index', async t => {
  const s = await setup(t);
  const api = createProductRetrieval(s);
  await api.refreshCatalog();
  let release!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; });
  const original = s.source.getProducts;
  s.source.getProducts = async page => { await block; return original(page); };
  const refreshing = api.refreshCatalog();
  const found = await api.findProductByArticle('200300283');
  assert.equal(found.matches[0]?.product.id, product.id);
  release();
  await refreshing;
});

test('concurrent refreshes across instances share one catalog build', async t => {
  const s = await setup(t);
  const a = createProductRetrieval(s), b = createProductRetrieval(s);
  await Promise.all([a.refreshCatalog(), a.refreshCatalog(), b.refreshCatalog()]);
  assert.equal(s.calls.pages, 2);
});

test('missing or corrupt cache returns warming promptly and recovers with a completed snapshot', async t => {
  const s = await setup(t);
  await writeFile(s.cachePath, '{broken');
  let release!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; });
  const original = s.source.getProducts;
  s.source.getProducts = async page => { await block; return original(page); };
  const api = createProductRetrieval(s);
  assert.equal((await api.initialize()).available, false);
  await assert.rejects(api.findProductByArticle('200300283'), { code: 'CATALOG_NOT_READY' });
  release();
  await api.refreshCatalog();
  assert.equal((await api.findProductByArticle('200300283')).matches[0]?.product.id, product.id);
  assert.equal(JSON.parse(await readFile(s.cachePath, 'utf8')).version, 1);
});

test('failed refresh preserves last good disk and memory indexes', async t => {
  const s = await setup(t);
  const api = createProductRetrieval(s);
  await api.refreshCatalog();
  const old = await readFile(s.cachePath, 'utf8');
  const original = s.source.getProducts;
  s.source.getProducts = async page => { if (page === 2) throw new EktApiError('NETWORK', 'safe'); return original(page); };
  await assert.rejects(api.refreshCatalog(), { code: 'NETWORK' });
  assert.equal(await readFile(s.cachePath, 'utf8'), old);
  const result = await api.findProductByArticle('200300283');
  assert.equal(result.coverage.refreshError, 'NETWORK');
  assert.equal(result.matches[0]?.product.id, product.id);
});

test('persisted stock is unknown and every fresh detail lookup contacts EKT', async t => {
  const s = await setup(t);
  await createProductRetrieval(s).refreshCatalog();
  const restarted = createProductRetrieval(s);
  const result = await restarted.findProductByArticle('200300283');
  assert.equal(result.matches[0]?.product.totalQuantity, null);
  assert.equal(result.matches[0]?.product.warehouses, null);
  assert.equal((await restarted.getNormalizedProductById(product.id)).totalQuantity, 1);
  assert.equal((await restarted.getNormalizedProductById(product.id)).totalQuantity, 2);
  assert.equal(s.calls.details, 2);
});

test('live-process lock prevents a competing refresh and still permits cached discovery', async t => {
  const s = await setup(t);
  const api = createProductRetrieval(s);
  await api.refreshCatalog();
  await writeFile(`${s.cachePath}.lock`, String(process.pid));
  await assert.rejects(api.refreshCatalog(), { code: 'CACHE_BUSY' });
  assert.equal((await api.findProductByArticle('200300283')).matches.length, 1);
});
