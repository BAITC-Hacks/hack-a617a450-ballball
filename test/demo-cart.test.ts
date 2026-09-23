import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProduct } from '../src/server/products/normalize.ts';
import { parseProductDetail } from '../src/server/ekt/validation.ts';
import { toWebProduct } from '../src/server/web/products.ts';
import { propose, confirm } from '../src/server/web/cart.ts';
import type { CartState } from '../src/server/web/cart.ts';
import { policyAnswer } from '../src/server/web/policy.ts';
const p = normalizeProduct(parseProductDetail(JSON.parse(readFileSync(new URL('./fixtures/product-515291.json', import.meta.url), 'utf8')), 515291));
test('proposal does not modify cart; explicit confirmation uses fresh stock and price', async () => {
  const state: CartState = { cart: [], pending: null };
  const proposal = propose(state, toWebProduct(p, false), 2);
  assert.equal(state.cart.length, 0);
  let calls = 0;
  await confirm(state, proposal.token, async id => { calls++; assert.equal(id, p.id); return { ...p, totalQuantity: 4, price: 123 }; });
  assert.equal(calls, 1); assert.equal(state.cart[0]?.quantity, 2); assert.equal(state.cart[0]?.product.price, 123);
  assert.equal(state.pending, null);
  await assert.rejects(confirm(state, proposal.token, async () => p));
});
test('cumulative quantity cannot exceed fresh stock; failure leaves cart unchanged', async () => {
  const state: CartState = { cart: [{ product: toWebProduct(p, true), quantity: 2 }], pending: null };
  const pending = propose(state, toWebProduct(p, false), 2);
  await assert.rejects(confirm(state, pending.token, async () => ({ ...p, totalQuantity: 3 })), /Недостаточно/);
  assert.equal(state.cart[0]?.quantity, 2);
});
test('unknown, zero stock and expired confirmations fail closed', async () => {
  for (const totalQuantity of [null, 0]) {
    const state: CartState = { cart: [], pending: null };
    const pending = propose(state, toWebProduct(p, false), 1);
    await assert.rejects(confirm(state, pending.token, async () => ({ ...p, totalQuantity })));
    assert.equal(state.cart.length, 0);
  }
  const state: CartState = { cart: [], pending: null };
  const pending = propose(state, toWebProduct(p, false), 1); pending.expiresAt = 0;
  await assert.rejects(confirm(state, pending.token, async () => p));
  for (const qty of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => propose(state, toWebProduct(p, false), qty));
});
test('concurrent confirmation cannot replay an action', async () => {
  const state: CartState = { cart: [], pending: null };
  const pending = propose(state, toWebProduct(p, false), 1);
  const results = await Promise.allSettled([confirm(state, pending.token, async () => ({ ...p, totalQuantity: 10 })), confirm(state, pending.token, async () => ({ ...p, totalQuantity: 10 }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(state.cart[0]?.quantity, 1);
});
test('web views hide unverified stock, preserve conflicts, and reject unsafe links', () => {
  const card = toWebProduct({ ...p, image: 'javascript:alert(1)', productUrl: 'javascript:alert(1)' }, false);
  assert.equal(card.quantity, null); assert.deepEqual(card.warehouses, []); assert.ok(card.warnings.length > 0);
  assert.equal(card.image, null); assert.equal(card.url, 'https://ekt.kz');
  assert.equal(toWebProduct(p, true).quantity, p.totalQuantity);
});
test('demo purchasing knowledge reports unavailable policies', () => {
  assert.match(policyAnswer('Оплата и доставка, минимальный заказ')!, /Демо-справка/);
  assert.match(policyAnswer('Оплата')!, /не предоставлены/);
  assert.equal(policyAnswer('Найди товар'), null);
});

test('alternatives discard unrelated references and compare real fallback detail values', async () => {
  const { alternatives } = await import('../src/server/web/products.ts');
  const base = { ...p, recommendationReferences: ['900001'] };
  const candidate = { ...p, id: 900002, article: 'candidate-fixture', conflicts: [], technicalCharacteristics: p.technicalCharacteristics.filter(c => !c.conflictDetected) };
  const calls: number[] = [];
  const result = await alternatives(p.id, {
    async getNormalizedProductById(id) { calls.push(id); return id === p.id ? base : id === 900001 ? { ...p, id, technicalCharacteristics: [] } : candidate; },
    async searchProducts(query) {
      assert.ok(query.length > 0);
      return { query, matches: [{ product: candidate, score: 1, matchedBy: 'name-phrase' as const }], coverage: { catalogPages: 1, catalogProducts: 1, catalogTermination: 'empty-page' as const, catalogComplete: true, catalogSource: 'cached' as const, pagesFetched: 0, nextPage: null, catalogFetchedAt: new Date().toISOString(), detailedProducts: 1, allScannedProductsDetailed: true } };
    },
  });
  assert.deepEqual(result.products.map(x => x.id), [900002]);
  assert.match(result.products[0]!.reason!, /Совпадают/);
  assert.match(result.products[0]!.reason!, /не подтверждены/);
  assert.deepEqual(calls, [p.id, 900001, 900002]);
});
