import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { createAssistant } from "../src/server/assistant/index.ts";
import type { ModelResponse, ProductTools, ToolTrace, TimingTrace } from "../src/server/assistant/contracts.ts";
import type { AnswerPlan } from "../src/server/assistant/protocol.ts";
import { createRedactor } from "../src/server/assistant/security.ts";
import { createOpenAITransport } from "../src/server/assistant/openai.ts";
import { normalizeProduct } from "../src/server/products/normalize.ts";
import { parseProductDetail, parseProducts } from "../src/server/ekt/validation.ts";
import { EktApiError } from "../src/server/ekt/errors.ts";
import { CatalogLoadError } from "../src/server/products/catalog.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const detail = normalizeProduct(parseProductDetail(fixture("product-515291"), 515291));
const summary = normalizeProduct(parseProducts(fixture("products-page-2"), 2).items[0]!);
const coverage = { catalogPages: 2, catalogProducts: 40, catalogTermination: "page-limit" as const, catalogComplete: false, catalogSource: "network" as const, pagesFetched: 2, nextPage: 3, catalogFetchedAt: "2026-09-23T00:00:00Z", detailedProducts: 0, allScannedProductsDetailed: false };
const basePlan: AnswerPlan = { language: "en", intent: "products", productIds: [515291], fields: ["price"], notices: [], policyTopic: null };
const answer = (patch: Partial<AnswerPlan> = {}): ModelResponse => ({ status: "completed", output: [], output_text: JSON.stringify({ ...basePlan, ...patch }) });
let callSequence = 0;
const call = (name: string, args: unknown): ModelResponse => ({
  status: "completed", output_text: "", output: [{ type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args), call_id: `call_${++callSequence}` }],
});

function setup(responses: (ModelResponse | Error)[], overrides: Partial<ProductTools> = {}) {
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const invoked: { name: string; arg: string | number }[] = [];
  const traces: ToolTrace[] = [];
  const timings: TimingTrace[] = [];
  const productTools: ProductTools = {
    async searchProducts(query) { invoked.push({ name: "search", arg: query }); return { query, coverage, matches: [{ product: summary, score: 700, matchedBy: "exact-article" }] }; },
    async findProductByArticle(article) { invoked.push({ name: "article", arg: article }); return { query: article, coverage, matches: [{ product: summary, score: 700, matchedBy: "exact-article" }] }; },
    async getNormalizedProductById(id) { invoked.push({ name: "detail", arg: id }); return structuredClone(detail); },
    ...overrides,
  };
  const assistant = createAssistant({ model: "mock-model", productTools, onTiming: event => timings.push(event), onToolTrace: trace => traces.push(trace), transport: {
    async create(request) {
      requests.push(structuredClone(request));
      const next = responses.shift();
      if (!next) throw new Error("No mock response left; tests must never use real OpenAI.");
      if (next instanceof Error) throw next;
      return next;
    },
  } });
  return { assistant, requests, invoked, traces, timings };
}

test("search tool dispatch uses existing retrieval and renders only trusted product facts", async () => {
  const s = setup([call("search_products", { query: "Legrand 160А" }), answer()]);
  const result = await s.assistant.send("Find Legrand 160A");
  assert.deepEqual(s.invoked, [{ name: "search", arg: "Legrand 160А" }]);
  assert.match(result.text, /64920/);
  assert.match(result.text, /currency not supplied/);
  assert.match(result.text, /200300285_/);
  assert.match(result.text, /https:\/\/ekt.kz\/catalog\//);
  assert.match(result.text, /Coverage may be incomplete/);
  assert.equal(s.requests[0]?.store, false);
  assert.equal(s.requests[0]?.model, "mock-model");
  assert.equal(s.requests[0]?.parallel_tool_calls, false);
  assert.deepEqual(s.requests[0]?.tools?.map(t => t.type === "function" ? t.name : t.type), ["search_products", "find_product_by_article", "get_product_details"]);
  const input = JSON.stringify(s.requests[1]?.input);
  assert.match(input, /function_call_output/);
  assert.match(input, /64920/);
  assert.equal(s.traces.length, 1);
});

test("article tool dispatch preserves exact article", async () => {
  const s = setup([call("find_product_by_article", { article: "200300285_" }), answer()]);
  await s.assistant.send("Артикул 200300285_");
  assert.deepEqual(s.invoked, [{ name: "article", arg: "200300285_" }]);
});

test("detail tool renders fresh total and per-warehouse quantities", async () => {
  const s = setup([call("get_product_details", { id: 515291 }), answer({ fields: ["stock"] })]);
  const { text } = await s.assistant.send("Stock for 515291?");
  assert.match(text, /Reported total quantity: 23/);
  assert.match(text, /Алматы \[13\]: 5/);
  assert.match(text, /sale eligibility and reservation are not confirmed/);
});

test("cached search quantities and empty offers never become current stock claims", async () => {
  const s = setup([call("search_products", { query: "Legrand" }), answer({ fields: ["stock"] })], {
    async searchProducts(query) { return { query, coverage, matches: [{ product: detail, score: 400, matchedBy: "name-phrase" }] }; },
  });
  const { text } = await s.assistant.send("How many?");
  assert.match(text, /Reported total quantity: unavailable \/ unknown/);
  assert.doesNotMatch(text, /Reported total quantity: (?:23|0)/);
});

test("missing fields and certificates are explicitly unavailable", async () => {
  const s = setup([call("search_products", { query: "Legrand" }), answer({ fields: ["brand", "specifications"], notices: ["certificates", "missing"] })]);
  const { text } = await s.assistant.send("Brand, specs and certificate?");
  assert.match(text, /Brand: unavailable \/ unknown/);
  assert.match(text, /cannot confirm a certificate exists/);
  assert.doesNotMatch(text, /certificate exists\.$/);
});

test("conflicts are mandatory even when the answer plan omits specs and conflict notices", async () => {
  const s = setup([call("get_product_details", { id: 515291 }), answer({ fields: [] })]);
  const { text } = await s.assistant.send("Tell me about 515291");
  assert.match(text, /EKT source data conflicts/);
  assert.match(text, /properties.NOMINALNYY_TOK: 250 А/);
  assert.match(text, /160 A/);
  assert.match(text, /verify with EKT/);
});

test("empty search is scoped and failures are not reported as no results", async () => {
  const empty = setup([call("search_products", { query: "unseen" }), answer({ productIds: [] })], {
    async searchProducts(query) { return { query, coverage, matches: [] }; },
  });
  assert.match((await empty.assistant.send("Find unseen")).text, /searched portion/);
  const failed = setup([call("search_products", { query: "unseen" }), answer({ productIds: [] })], {
    async searchProducts() { throw new EktApiError("NETWORK", "Sensitive upstream error"); },
  });
  const { text } = await failed.assistant.send("Find unseen");
  assert.match(text, /could not be retrieved/);
  assert.doesNotMatch(text, /No matches|Sensitive upstream error/);
});

test("multi-turn history supports references but requires fresh current-turn evidence", async () => {
  const s = setup([
    call("find_product_by_article", { article: "200300285_" }), answer({ language: "ru" }),
    call("get_product_details", { id: 515291 }), answer({ language: "ru", fields: ["stock"] }),
  ]);
  await s.assistant.send("Найди 200300285_");
  const second = await s.assistant.send("А сколько их осталось?");
  assert.match(JSON.stringify(s.requests[2]?.input), /515291/);
  assert.match(JSON.stringify(s.requests[2]?.input), /А сколько их осталось/);
  assert.match(second.text, /Общее количество по данным EKT: 23/);
  assert.deepEqual(s.invoked.at(-1), { name: "detail", arg: 515291 });
});

test("previous-turn product facts alone cannot authorize a new factual answer", async () => {
  const s = setup([call("get_product_details", { id: 515291 }), answer(), answer({ fields: ["stock"] })]);
  await s.assistant.send("515291");
  await assert.rejects(s.assistant.send("Stock now?"), { code: "GROUNDING" });
});

test("fabricated prices, quantities, specifications and free prose are rejected", async () => {
  for (const fabricated of [
    "Price is 1 and 999 are available, nominal current 400 A.",
    JSON.stringify({ ...basePlan, price: 1, stock: 999, specifications: "400 A" }),
    JSON.stringify({ ...basePlan, fields: ["price=1"] }),
  ]) {
    const s = setup([call("get_product_details", { id: 515291 }), { status: "completed", output: [], output_text: fabricated }]);
    await assert.rejects(s.assistant.send("Give product facts"), { code: "MODEL_OUTPUT" });
  }
  const inventedId = setup([call("get_product_details", { id: 515291 }), answer({ productIds: [123456789] })]);
  await assert.rejects(inventedId.assistant.send("Product?"), { code: "GROUNDING" });
  const noTool = setup([answer()]);
  await assert.rejects(noTool.assistant.send("Product?"), { code: "GROUNDING" });
});

test("OpenAI failure is sanitized and failed turns do not enter history", async () => {
  const s = setup([new Error("Sensitive raw API error"), answer({ intent: "greeting", productIds: [] })]);
  await assert.rejects(s.assistant.send("Failed question"), error => {
    assert.equal((error as { code: string }).code, "OPENAI");
    assert.doesNotMatch(String(error), /Sensitive/);
    return true;
  });
  await s.assistant.send("Hello");
  assert.doesNotMatch(JSON.stringify(s.requests[1]?.input), /Failed question/);
});

test("malformed tool calls and unknown tools cannot invoke backend actions", async () => {
  for (const response of [call("modify_cart", { id: 515291 }), call("get_product_details", { id: "515291" }), call("search_products", { query: "x", extra: true }), call("search_products", "{broken")]) {
    const s = setup([response, answer({ intent: "unavailable", productIds: [] })]);
    await s.assistant.send("Product?");
    assert.deepEqual(s.invoked, []);
    assert.match(JSON.stringify(s.requests[1]?.input), /INVALID_TOOL_CALL/);
  }
});

test("incomplete model responses and runaway tool loops fail closed", async () => {
  const incomplete = setup([{ status: "incomplete", output: [], output_text: JSON.stringify(basePlan) }]);
  await assert.rejects(incomplete.assistant.send("Product?"), { code: "MODEL_OUTPUT" });
  const loop = setup(Array.from({ length: 6 }, () => call("search_products", { query: "Legrand" })));
  await assert.rejects(loop.assistant.send("Product?"), { code: "LIMIT" });
  assert.equal(loop.requests.length, 6);
});

test("cart, policy, certificate and alternative responses do not invent capabilities", async () => {
  for (const [intent, pattern] of [
    ["cart", /Nothing has been added/], ["policy", /information is unavailable/],
    ["certificates", /cannot confirm/], ["alternatives", /has not been verified/],
  ] as const) {
    const s = setup([answer({ intent, productIds: [], fields: [] })]);
    assert.match((await s.assistant.send("Question")).text, pattern);
    assert.deepEqual(s.invoked, []);
  }
});

test("Kazakh and Russian reply templates work without generating translated product facts", async () => {
  const kk = setup([call("get_product_details", { id: 515291 }), answer({ language: "kk", fields: ["stock"] })]);
  assert.match((await kk.assistant.send("Қанша қалды?")).text, /жалпы саны: 23/);
  const ru = setup([answer({ language: "ru", intent: "clarify", productIds: [] })]);
  assert.match((await ru.assistant.send("А этот?")).text, /Уточните/);
});

test("reset and separate assistant instances do not share conversation state", async () => {
  const s = setup([answer({ intent: "greeting", productIds: [] }), answer({ intent: "clarify", productIds: [] })]);
  await s.assistant.send("Private prior turn");
  s.assistant.reset();
  await s.assistant.send("New turn");
  assert.doesNotMatch(JSON.stringify(s.requests[1]?.input), /Private prior turn/);
  const other = setup([answer({ intent: "greeting", productIds: [] })]);
  await other.assistant.send("Hello");
  assert.doesNotMatch(JSON.stringify(other.requests[0]?.input), /New turn/);
});

test("sensitive strings are redacted without embedding any actual configuration in tests", () => {
  const key = randomUUID();
  const password = randomUUID();
  const model = randomUUID();
  const username = randomUUID();
  const clean = createRedactor({ OPENAI_API_KEY: key, OPENAI_MODEL: model, EKT_API_USERNAME: username, EKT_API_PASSWORD: password });
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const text = clean([key, password, username, model, auth, `Authorization: Basic ${auth}`].join(" "));
  for (const secret of [key, password, username, model, auth]) assert.ok(!text.includes(secret));
});

test("suspected card numbers are rejected before model calls or storage", async () => {
  // Synthetic Luhn-valid number generated in memory; not a real card fixture.
  const digits = "4" + "1".repeat(14);
  let candidate = "";
  const { containsCardNumber } = await import("../src/server/assistant/security.ts");
  for (let i = 0; i < 10; i++) if (containsCardNumber(digits + i)) candidate = digits + i;
  const s = setup([]);
  assert.match((await s.assistant.send(candidate)).text, /не сохранено/);
  assert.equal(s.requests.length, 0);
});

test("reasoning items and function call IDs survive the within-turn Responses loop", async () => {
  const first = call("get_product_details", { id: 515291 });
  first.output.unshift({ type: "reasoning", id: "reasoning-test", summary: [], encrypted_content: "opaque-test-content" });
  const s = setup([first, answer()]);
  await s.assistant.send("515291");
  assert.match(JSON.stringify(s.requests[1]?.input), /opaque-test-content/);
  assert.match(JSON.stringify(s.requests[1]?.input), /function_call_output/);
});

test("SDK adapter uses env configuration, official Responses endpoint, and sanitizes API errors without real network", async t => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;
  const key = randomUUID();
  const model = randomUUID();
  process.env.OPENAI_API_KEY = key;
  process.env.OPENAI_MODEL = model;
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = originalModel;
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${key}`);
    assert.equal(JSON.parse(init?.body as string).model, model);
    return Response.json({ error: { message: key, type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
  });
  const configured = createOpenAITransport();
  assert.equal(configured.model, model);
  await assert.rejects(configured.transport.create({ model: configured.model, input: "mock", store: false }), error => {
    assert.equal((error as { code: string }).code, "OPENAI");
    assert.ok(!String(error).includes(key));
    return true;
  });
  assert.equal(requests, 1);
});

test("a future trusted policy source does not suppress mandatory conflicts or cart disclaimers", async () => {
  const assistant = createAssistant({
    model: "mock-model", transport: { async create() {
      return answer({ intent: "policy", productIds: [], policyTopic: "delivery", notices: ["cart"] });
    } },
    policySource: { async lookup() { return { text: "Trusted test policy text", sourceUrl: "https://example.com/policy" }; } },
  });
  const { text } = await assistant.send("Delivery policy and add to cart");
  assert.match(text, /Trusted test policy text/);
  assert.match(text, /Nothing has been added/);
  assert.doesNotMatch(text, /Authoritative payment/);
});

test("concurrent turns are rejected rather than mixing tool evidence/history", async () => {
  let release!: (response: ModelResponse) => void;
  const assistant = createAssistant({ model: "mock-model", transport: { create: () => new Promise(resolve => { release = resolve; }) } });
  const first = assistant.send("Hello");
  await assert.rejects(assistant.send("Another turn"), { code: "BUSY" });
  assert.throws(() => assistant.reset(), { code: "BUSY" });
  release(answer({ intent: "greeting", productIds: [] }));
  await first;
});

test("partial catalog failures expose coverage to the model without claiming no results", async () => {
  const partial = { ...coverage, catalogTermination: "error" as const };
  const s = setup([call("find_product_by_article", { article: "missing" }), answer({ intent: "unavailable", productIds: [] })], {
    async findProductByArticle() { throw new CatalogLoadError(new EktApiError("NETWORK", "raw"), partial); },
  });
  const reply = await s.assistant.send("Find article");
  assert.match(JSON.stringify(s.requests[1]?.input), /catalogComplete/);
  assert.match(reply.text, /could not be retrieved/);
  assert.match(reply.text, /Partial catalog scan/);
  assert.doesNotMatch(reply.text, /No matches/);
});

test("article variant warning survives detail refresh; complete cached coverage stays explicit", async () => {
  const s = setup([call("find_product_by_article", { article: "200300285" }), call("get_product_details", { id: 515291 }), answer()], {
    async findProductByArticle(query) { return { query, coverage: { ...coverage, catalogComplete: true, catalogSource: "cached", catalogTermination: "empty-page", nextPage: null, pagesFetched: 0 }, matches: [{ product: summary, score: 650, matchedBy: "article-variant" }] }; },
  });
  const reply = await s.assistant.send("Find article 200300285");
  assert.match(reply.text, /not an exact match/);
  assert.match(reply.text, /Catalog summary scan complete/);
  assert.match(reply.text, /Cached catalog data/);
});

test("timing traces distinguish model, discovery and detail duration without model/config values", async () => {
  const s = setup([call("search_products", { query: "Legrand" }), call("get_product_details", { id: 515291 }), answer()]);
  await s.assistant.send("Find a product and current price");
  assert.deepEqual(s.timings.map(t => t.operation), ["openai", "catalog-search", "openai", "product-detail", "openai"]);
  assert.ok(s.timings.every(t => t.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(s.timings), /mock-model|Authorization/);
});

test("cached prices are labeled historical; fresh detail prices are not", async () => {
  const cached = setup([call("search_products", { query: "Legrand" }), answer()]);
  assert.match((await cached.assistant.send("Find Legrand")).text, /not a current quote/);
  const fresh = setup([call("get_product_details", { id: 515291 }), answer()]);
  assert.doesNotMatch((await fresh.assistant.send("Current price?")).text, /not a current quote/);
});

test("cache warming is explained without claiming product absence", async () => {
  const s = setup([call("search_products", { query: "Legrand" }), answer({ intent: "unavailable", productIds: [] })], {
    async searchProducts() { throw new EktApiError("CATALOG_NOT_READY", "warming"); },
  });
  assert.match((await s.assistant.send("Find Legrand")).text, /index is warming/);
});
