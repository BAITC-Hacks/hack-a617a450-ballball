import type { ResponseInput, ResponseInputItem } from "openai/resources/responses/responses";
import { searchProducts, findProductByArticle, getNormalizedProductById } from "../products/index.ts";
import type { Product, SearchCoverage } from "../products/index.ts";
import { EktApiError } from "../ekt/errors.ts";
import { CatalogLoadError } from "../products/catalog.ts";
import { AssistantError } from "./contracts.ts";
import type { AssistantReply, ProductTools, ResponsesTransport, ToolTrace, PurchasingPolicySource, TimingTrace } from "./contracts.ts";
import { createOpenAITransport } from "./openai.ts";
import { createRedactor, containsCardNumber } from "./security.ts";
import { tools, instructions, answerFormat, parsePlan } from "./protocol.ts";
import { renderAnswer, cardWarning } from "./render.ts";
import type { Evidence } from "./render.ts";
export { AssistantError } from "./contracts.ts";
export type { AssistantReply, ToolTrace, PurchasingPolicySource } from "./contracts.ts";

export interface AssistantOptions {
  /** Inject both only in server-side tests; real configuration comes from env. */
  transport?: ResponsesTransport;
  model?: string;
  productTools?: ProductTools;
  onToolTrace?: (trace: ToolTrace) => void;
  onTiming?: (trace: TimingTrace) => void;
  policySource?: PurchasingPolicySource;
}

/** One instance per conversation/user. No global shared chat history. */
export function createAssistant(options: AssistantOptions = {}) {
  const configured = options.transport
    ? { transport: options.transport, model: options.model }
    : createOpenAITransport();
  if (!configured.model) throw new AssistantError("CONFIGURATION");
  const model = configured.model;
  const products = options.productTools ?? { searchProducts, findProductByArticle, getNormalizedProductById };
  const redact = createRedactor();
  let history: { role: "user" | "assistant"; content: string }[] = [];
  let lastActive = Date.now();
  let busy = false;
  const timing = (event: TimingTrace) => { try { options.onTiming?.(event); } catch {} };

  const safeJson = (value: unknown): string => {
    const text = JSON.stringify(value);
    if (text.length > 100_000) throw new AssistantError("LIMIT");
    return redact(text);
  };
  function productView(product: Product) {
    const { raw: _raw, ...view } = product;
    return view;
  }

  return {
    remember(user: string, answer: string) {
      if (busy) throw new AssistantError("BUSY");
      if (containsCardNumber(user)) return;
      history = [...history, { role: "user" as const, content: redact(user) }, { role: "assistant" as const, content: redact(answer) }].slice(-20);
      lastActive = Date.now();
    },
    reset() {
      if (busy) throw new AssistantError("BUSY");
      history = [];
    },
    async send(message: string): Promise<AssistantReply> {
      if (typeof message !== "string" || !message.trim() || message.length > 4000) throw new AssistantError("INVALID_INPUT");
      if (busy) throw new AssistantError("BUSY");
      if (containsCardNumber(message)) return { text: cardWarning(), productIds: [] };
      busy = true;
      try {
        if (Date.now() - lastActive > 30 * 60_000) history = [];
        const user = redact(message);
        const input: ResponseInput = [...history, { role: "user", content: user }];
        const evidence = new Map<number, Evidence>();
        const coverage: SearchCoverage[] = [];
        let toolError = false;
        let catalogWarming = false;
        let toolCount = 0;
        let successfulSearch = false;
        const callIds = new Set<string>();

        async function execute(name: string, argumentsText: string): Promise<string> {
          const started = performance.now();
          let success = false;
          let cacheLayer: string | undefined;
          let args: Record<string, string | number> = {};
          let result: unknown;
          try {
            if (argumentsText.length > 2000) throw new Error();
            const parsed: unknown = JSON.parse(argumentsText);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
            const object = parsed as Record<string, unknown>;
            const key = name === "search_products" ? "query" : name === "find_product_by_article" ? "article" : name === "get_product_details" ? "id" : null;
            if (!key || Object.keys(object).length !== 1 || !Object.hasOwn(object, key)) throw new Error();
            const value = object[key];
            if (key === "id") {
              if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error();
              args = { id: value };
            } else {
              if (typeof value !== "string" || !value.trim() || value.length > 500 || containsCardNumber(value)) throw new Error();
              args = { [key]: redact(value) };
            }
          } catch {
            toolError = true;
            return JSON.stringify({ error: "INVALID_TOOL_CALL" });
          }
          try {
            if (name === "get_product_details") {
              const product = await products.getNormalizedProductById(args.id as number);
              if (product.id !== args.id) throw new Error();
              // Keep the same sanitized view in evidence and model context.
              const safe = JSON.parse(safeJson(product)) as Product;
              evidence.set(safe.id, { product: safe, fresh: true, articleVariant: evidence.get(safe.id)?.articleVariant });
              result = { product: productView(safe), fresh: true };
              success = true;
            } else {
              const found = name === "search_products" ? await products.searchProducts(args.query as string) : await products.findProductByArticle(args.article as string);
              const shown = found.matches.slice(0, 5).map(match => {
                const safe = JSON.parse(safeJson(match.product)) as Product;
                if (!evidence.get(safe.id)?.fresh) evidence.set(safe.id, { product: safe, fresh: false, articleVariant: match.matchedBy === "article-variant" });
                return { product: productView(safe), score: match.score, matchedBy: match.matchedBy };
              });
              coverage.push(found.coverage);
              cacheLayer = found.coverage.cacheLayer ?? found.coverage.catalogSource;
              successfulSearch = true;
              success = true;
              result = { matches: shown, coverage: found.coverage, totalMatches: found.matches.length, truncated: found.matches.length > shown.length, fresh: false };
            }
          } catch (error) {
            toolError = true;
            if (error instanceof EktApiError && error.code === "CATALOG_NOT_READY") catalogWarming = true;
            if (typeof args.id === "number") evidence.delete(args.id);
            if (error instanceof CatalogLoadError) coverage.push(error.coverage);
            result = { error: error instanceof EktApiError ? error.code : "RETRIEVAL_FAILED",
              ...(error instanceof CatalogLoadError ? { coverage: error.coverage } : {}) };
          }
          const serialized = safeJson(result);
          const durationMs = Math.round((performance.now() - started) * 100) / 100;
          timing({ operation: name === "get_product_details" ? "product-detail" : "catalog-search", durationMs, success, cacheLayer });
          // Trace observers cannot break the conversation or receive raw errors/config.
          try { options.onToolTrace?.(JSON.parse(safeJson({ tool: name, arguments: args, durationMs, result: JSON.parse(serialized) }))); } catch {}
          return serialized;
        }

        for (let round = 0; round < 6; round++) {
          if (JSON.stringify(input).length > 250_000) throw new AssistantError("LIMIT");
          let response;
          const requestStarted = performance.now();
          let requestSucceeded = false;
          try {
            response = await configured.transport.create({
              model, instructions, input: structuredClone(input), tools,
              store: false, stream: false, parallel_tool_calls: false,
              include: ["reasoning.encrypted_content"], max_output_tokens: 2000,
              text: { format: answerFormat },
            });
            requestSucceeded = true;
          } catch { throw new AssistantError("OPENAI"); }
          finally { timing({ operation: "openai", durationMs: Math.round(performance.now() - requestStarted), success: requestSucceeded }); }
          if (response.status !== "completed" || !Array.isArray(response.output)) throw new AssistantError("MODEL_OUTPUT");
          const calls = response.output.filter(item => item.type === "function_call");
          if (calls.length) {
            const carry = response.output.filter(item => ["function_call", "reasoning", "message"].includes(item.type));
            // Opaque encrypted reasoning must round-trip byte-for-byte. This
            // transient protocol data is never logged, rendered, or persisted.
            input.push(...structuredClone(carry) as ResponseInputItem[]);
            for (const call of calls) {
              if (++toolCount > 8 || callIds.has(call.call_id)) throw new AssistantError("LIMIT");
              callIds.add(call.call_id);
              input.push({ type: "function_call_output", call_id: call.call_id, output: await execute(call.name, call.arguments) });
            }
            continue;
          }
          const plan = parsePlan(response.output_text);
          if (plan.productIds.some(id => !evidence.has(id))) throw new AssistantError("GROUNDING");
          if (plan.intent === "products" && !plan.productIds.length && (!successfulSearch || evidence.size > 0) && !toolError) throw new AssistantError("GROUNDING");
          let policy = null;
          if (plan.intent === "policy" && plan.policyTopic && options.policySource) {
            try {
              const found = await options.policySource.lookup(plan.policyTopic, plan.language);
              if (found) {
                const url = new URL(found.sourceUrl);
                if (url.protocol === "https:" && !url.username && !url.password) policy = found;
              }
            } catch { /* No authoritative policy: keep the unavailable answer. */ }
          }
          const text = redact(catalogWarming && plan.productIds.length === 0 ? {
            en: "The catalog index is warming. Please retry shortly; this does not mean the product is absent.",
            ru: "Индекс каталога загружается. Попробуйте немного позже; это не означает, что товара нет.",
            kk: "Каталог индексі жүктеліп жатыр. Біраздан кейін қайталаңыз; бұл тауар жоқ дегенді білдірмейді.",
          }[plan.language] : renderAnswer(plan, evidence, coverage, toolError, policy));
          if (text.length > 30_000) throw new AssistantError("LIMIT");
          history = [...history, { role: "user" as const, content: user }, { role: "assistant" as const, content: text }].slice(-20);
          lastActive = Date.now();
          return { text, productIds: [...new Set(plan.productIds)], products: [...new Set(plan.productIds)].map(id => ({ product: productView(evidence.get(id)!.product), fresh: evidence.get(id)!.fresh })) };
        }
        throw new AssistantError("LIMIT");
      } finally { busy = false; }
    },
  };
}
