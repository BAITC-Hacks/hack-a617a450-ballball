// Node built-ins and the runtime guard deliberately prevent browser use.
import { Buffer } from "node:buffer";
import { EktApiError } from "./errors.ts";
import { parseProducts, parseProductDetail } from "./validation.ts";
import type { EktProductsResponse, EktProductDetail } from "./types.ts";
export type { EktProductsResponse, EktProductSummary, EktProductDetail, EktStore, EktProperties, EktPropertyValue } from "./types.ts";

if (typeof window !== "undefined") {
  throw new Error("The EKT client must only be imported on the server.");
}

const API_ORIGIN = "https://ekt.kz";
const TIMEOUT_MS = 15_000;

export interface EktClientOptions {
  /** Dependency injection for tests; production uses the built-in fetch. */
  fetch?: typeof globalThis.fetch;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EktApiError("INVALID_ARGUMENT", `${name} must be a positive safe integer.`);
  }
}

/** Read-only, server-side EKT client with validation of the observed wire schema. */
export function createEktClient(options: EktClientOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request(path: string, parameters: Record<string, string>): Promise<unknown> {
    const username = process.env.EKT_API_USERNAME;
    const password = process.env.EKT_API_PASSWORD;
    if (!username || !password || username.includes(":")) {
      throw new EktApiError(
        "CONFIGURATION",
        "Set EKT_API_USERNAME and EKT_API_PASSWORD on the server; the username must not contain a colon.",
      );
    }

    const url = new URL(path, API_ORIGIN);
    url.search = new URLSearchParams(parameters).toString();
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
        },
        // Never follow redirects with credentials or cache account-specific data.
        redirect: "error",
        cache: "no-store",
        signal,
      });
    } catch {
      throw new EktApiError("NETWORK", "Unable to reach the EKT API (network, timeout, or redirect failure).");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        throw new EktApiError("AUTHENTICATION", "EKT API authentication failed.", response.status);
      }
      if (response.status === 404) {
        throw new EktApiError("NOT_FOUND", "The requested EKT resource was not found.", 404);
      }
      throw new EktApiError("HTTP", `EKT API returned HTTP ${response.status}.`, response.status);
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new EktApiError("NETWORK", "Unable to read the EKT API response.");
    }
    try {
      const data: unknown = JSON.parse(body);
      if (data === null || typeof data !== "object") throw new Error("Not a JSON container");
      return data;
    } catch {
      throw new EktApiError("MALFORMED_RESPONSE", "EKT API returned invalid JSON or a non-container JSON value.", response.status);
    }
  }

  return {
    async getProducts(page = 1): Promise<EktProductsResponse> {
      requirePositiveInteger(page, "page");
      return parseProducts(await request("/api/products", page === 1 ? {} : { page: String(page) }), page);
    },
    async getProductById(id: number): Promise<EktProductDetail> {
      requirePositiveInteger(id, "id");
      return parseProductDetail(await request("/api/products/detail", { id: String(id) }), id);
    },
  };
}

const defaultClient = createEktClient();
export const getProducts = defaultClient.getProducts;
export const getProductById = defaultClient.getProductById;
