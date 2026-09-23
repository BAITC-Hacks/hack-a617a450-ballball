import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createEktClient } from "../src/server/ekt/client.ts";
import { EktApiError } from "../src/server/ekt/errors.ts";
import type { EktErrorCode } from "../src/server/ekt/errors.ts";
import type { EktProductDetail, EktProductsResponse } from "../src/server/ekt/types.ts";

// Copies of the user-supplied authenticated response bodies; no auth headers.
const page1: EktProductsResponse = JSON.parse(readFileSync(new URL("./fixtures/products-page-1.json", import.meta.url), "utf8"));
const page2: EktProductsResponse = JSON.parse(readFileSync(new URL("./fixtures/products-page-2.json", import.meta.url), "utf8"));
const detail: EktProductDetail = JSON.parse(readFileSync(new URL("./fixtures/product-515291.json", import.meta.url), "utf8"));

const clientWith = (body: unknown) => createEktClient({ fetch: async () => Response.json(body) });

const originalUsername = process.env.EKT_API_USERNAME;
const originalPassword = process.env.EKT_API_PASSWORD;
before(() => {
  // Deliberately fake credentials used only by mocked requests.
  process.env.EKT_API_USERNAME = "test-user";
  process.env.EKT_API_PASSWORD = "test-password";
});
after(() => {
  if (originalUsername === undefined) delete process.env.EKT_API_USERNAME;
  else process.env.EKT_API_USERNAME = originalUsername;
  if (originalPassword === undefined) delete process.env.EKT_API_PASSWORD;
  else process.env.EKT_API_PASSWORD = originalPassword;
});

function hasCode(code: EktErrorCode, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof EktApiError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(!String(error).includes("test-password"));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("uses fixed HTTPS URLs, Basic auth, GET, no cache, timeout, and no redirects", async () => {
  const urls: string[] = [];
  const client = createEktClient({
    fetch: async (input, init) => {
      urls.push(String(input));
      assert.equal(init?.method, "GET");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Accept"), "application/json");
      assert.equal(headers.get("Authorization"), `Basic ${Buffer.from("test-user:test-password").toString("base64")}`);
      const url = new URL(String(input));
      return Response.json(url.pathname.endsWith("/detail") ? detail : url.searchParams.get("page") === "2" ? page2 : page1);
    },
  });
  assert.deepEqual(await client.getProducts(), page1);
  assert.deepEqual(await client.getProducts(2), page2);
  assert.deepEqual(await client.getProductById(515291), detail);
  assert.deepEqual(urls, [
    "https://ekt.kz/api/products",
    "https://ekt.kz/api/products?page=2",
    "https://ekt.kz/api/products/detail?id=515291",
  ]);
});

test("real snapshots preserve IDs, null images, prices, stock, and conflicting characteristics", async () => {
  const first = await clientWith(page1).getProducts();
  const second = await clientWith(page2).getProducts(2);
  const product = await clientWith(detail).getProductById(515291);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 20);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 40);
  assert.equal(first.items.find(item => item.id === 25397)?.image, null);
  assert.equal(second.items[0]?.id, product.id);
  assert.equal(product.article, "200300285_");
  assert.equal(product.price, 64920);
  assert.equal(product.quantity, 23);
  assert.equal(product.stores.length, 24);
  assert.equal(product.stores.reduce((sum, store) => sum + store.quantity, 0), 23);
  assert.equal(product.properties.ARTIKULPOSTAVSHCHIKA, "027228");
  assert.equal(product.properties.NOMINALNYY_TOK, "250 А");
  assert.match(product.name, /160А/);
  assert.match(product.description, /160А/);
  assert.deepEqual(product.properties.RECOMMEND, ["48783", "23466", "28727"]);
  assert.notEqual(second.items[0]?.image, product.image);
  assert.ok(!Object.hasOwn(product, "url_api_detail"));
});

test("supports structurally valid empty pages without claiming live end-of-pages behavior", async () => {
  const empty = { page: 3, per_page: 20, count: 0, items: [] };
  assert.deepEqual(await clientWith(empty).getProducts(3), empty);
});

test("requires matching requested page and product ID", async () => {
  await assert.rejects(clientWith(page1).getProducts(2), hasCode("MALFORMED_RESPONSE", 200));
  await assert.rejects(clientWith(detail).getProductById(1), hasCode("MALFORMED_RESPONSE", 200));
});

test("rejects invalid catalog envelopes and products, including nested values", async () => {
  const changes: ((body: EktProductsResponse) => void)[] = [
    body => { Object.assign(body, { items: {} }); },
    body => { Object.assign(body, { page: "1" }); },
    body => { body.count = 19; },
    body => { body.per_page = 0; },
    body => { body.per_page = 1; },
    body => { Object.assign(body.items[0]!, { id: "45357" }); },
    body => { Object.assign(body.items[0]!, { price: "1810" }); },
    body => { Object.assign(body.items[0]!, { price: -1 }); },
    body => { Object.assign(body.items[0]!, { image: false }); },
    body => { Object.assign(body.items[0]!, { url: "javascript:alert(1)" }); },
    body => { Object.assign(body.items[0]!, { url_api_detail: null }); },
    body => { Object.assign(body.items[0]!, { offers: {} }); },
    body => { Reflect.deleteProperty(body.items[0]!, "article"); },
  ];
  for (const change of changes) {
    const body = structuredClone(page1);
    change(body);
    await assert.rejects(clientWith(body).getProducts(), hasCode("MALFORMED_RESPONSE", 200));
  }
  for (const body of [{}, [], { items: [] }]) {
    await assert.rejects(clientWith(body).getProducts(), hasCode("MALFORMED_RESPONSE", 200));
  }
});

test("rejects invalid detail fields, store quantities, and property shapes", async () => {
  const changes: ((body: EktProductDetail) => void)[] = [
    body => { Object.assign(body, { quantity: "23" }); },
    body => { body.quantity = -1; },
    body => { Object.assign(body, { stores: null }); },
    body => { Object.assign(body.stores[0]!, { quantity: "0" }); },
    body => { Object.assign(body.stores[0]!, { id: null }); },
    body => { Reflect.deleteProperty(body, "description"); },
    body => { Object.assign(body, { properties: [] }); },
    body => { Object.assign(body.properties, { NOMINALNYY_TOK: 250 }); },
    body => { Object.assign(body.properties, { NOMINALNYY_TOK: ["250 А"] }); },
    body => { Object.assign(body.properties, { RECOMMEND: [48783] }); },
    body => { Object.assign(body.properties, { CML2_TRAITS: "text" }); },
    body => { Object.assign(body.properties, { NEW_PROPERTY: { value: "text" } }); },
  ];
  for (const change of changes) {
    const body = structuredClone(detail);
    change(body);
    await assert.rejects(clientWith(body).getProductById(515291), hasCode("MALFORMED_RESPONSE", 200));
  }
  await assert.rejects(clientWith({}).getProductById(515291), hasCode("MALFORMED_RESPONSE", 200));
});

test("does not require product-specific properties or invent an offer schema", async () => {
  const body = { ...detail, properties: { FUTURE_PROPERTY: ["raw", "strings"] }, offers: [{ unverified: true }] };
  assert.deepEqual(await clientWith(body).getProductById(515291), body);
  assert.deepEqual((await clientWith({ ...detail, properties: {} }).getProductById(515291)).properties, {});
});

test("handles the observed Unauthorized envelope and sanitizes other error payloads", async () => {
  await assert.rejects(clientWith({ error: "Unauthorized" }).getProducts(), hasCode("AUTHENTICATION", 200));
  await assert.rejects(clientWith({ error: "test-password" }).getProductById(515291), hasCode("API_ERROR", 200));
  // No observed missing-product envelope: do not mislabel an empty object as NOT_FOUND.
  await assert.rejects(clientWith({}).getProductById(515291), hasCode("MALFORMED_RESPONSE", 200));
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`handles HTTP ${status} without exposing upstream body`, async () => {
    const client = createEktClient({ fetch: async () => new Response("test-password", { status }) });
    const code = status === 401 || status === 403 ? "AUTHENTICATION" : status === 404 ? "NOT_FOUND" : "HTTP";
    await assert.rejects(client.getProductById(515291), hasCode(code, status));
  });
}

test("sanitizes network and timeout failures", async () => {
  for (const error of [new Error("test-password"), new DOMException("test-password", "TimeoutError")]) {
    const client = createEktClient({ fetch: async () => { throw error; } });
    await assert.rejects(client.getProducts(), hasCode("NETWORK"));
  }
});

test("handles interrupted response bodies as network errors", async () => {
  const client = createEktClient({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("test-password")); },
  })) });
  await assert.rejects(client.getProducts(), hasCode("NETWORK"));
});

for (const body of ["<html>not JSON</html>", "", "null", "42", '"text"', "true"]) {
  test(`rejects malformed/non-container JSON: ${JSON.stringify(body)}`, async () => {
    const client = createEktClient({ fetch: async () => new Response(body) });
    await assert.rejects(client.getProducts(), hasCode("MALFORMED_RESPONSE", 200));
  });
}

test("rejects invalid IDs and pages before any network request", async () => {
  const client = createEktClient({ fetch: async () => { assert.fail("Must not fetch"); } });
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.getProducts(value), hasCode("INVALID_ARGUMENT"));
    await assert.rejects(client.getProductById(value), hasCode("INVALID_ARGUMENT"));
  }
});

test("missing credentials and invalid Basic username fail before fetching", async () => {
  const client = createEktClient({ fetch: async () => { assert.fail("Must not fetch"); } });
  try {
    delete process.env.EKT_API_PASSWORD;
    await assert.rejects(client.getProducts(), hasCode("CONFIGURATION"));
    process.env.EKT_API_PASSWORD = "test-password";
    process.env.EKT_API_USERNAME = "invalid:username";
    await assert.rejects(client.getProducts(), hasCode("CONFIGURATION"));
  } finally {
    process.env.EKT_API_USERNAME = "test-user";
    process.env.EKT_API_PASSWORD = "test-password";
  }
});
