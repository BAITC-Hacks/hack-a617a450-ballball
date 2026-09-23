import type { ResponseCreateParamsNonStreaming, ResponseOutputItem } from "openai/resources/responses/responses";
import type { Product, ProductSearchResult } from "../products/index.ts";

export type Language = "ru" | "kk" | "en";
export type PolicyTopic = "payment" | "delivery" | "minimum-order";
/** Future trusted policy adapter, supplied by server code, never by the model. */
export interface PurchasingPolicySource {
  lookup(topic: PolicyTopic, language: Language): Promise<{ text: string; sourceUrl: string } | null>;
}
export interface ProductTools {
  searchProducts(query: string): Promise<ProductSearchResult>;
  findProductByArticle(article: string): Promise<ProductSearchResult>;
  getNormalizedProductById(id: number): Promise<Product>;
}
export interface ModelResponse {
  status?: string;
  output: ResponseOutputItem[];
  output_text: string;
}
export interface ResponsesTransport {
  create(request: ResponseCreateParamsNonStreaming): Promise<ModelResponse>;
}
export type AssistantErrorCode = "CONFIGURATION" | "INVALID_INPUT" | "BUSY" | "OPENAI" | "MODEL_OUTPUT" | "LIMIT" | "GROUNDING";
export class AssistantError extends Error {
  readonly code: AssistantErrorCode;
  constructor(code: AssistantErrorCode) {
    super(`Assistant request failed (${code}).`);
    this.name = "AssistantError";
    this.code = code;
  }
}
export interface ToolTrace {
  tool: string;
  arguments: Record<string, string | number>;
  result: unknown;
  durationMs?: number;
}
export interface TimingTrace { operation: "openai" | "catalog-search" | "product-detail"; durationMs: number; success: boolean; cacheLayer?: string }
export interface AssistantReply {
  text: string;
  productIds: number[];
  products?: { product: Omit<Product, "raw">; fresh: boolean }[];
}
