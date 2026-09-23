export type EktErrorCode =
  | "CONFIGURATION"
  | "CATALOG_NOT_READY"
  | "CACHE_BUSY"
  | "CACHE_IO"
  | "INVALID_ARGUMENT"
  | "AUTHENTICATION"
  | "NETWORK"
  | "NOT_FOUND"
  | "MALFORMED_RESPONSE"
  | "API_ERROR"
  | "HTTP";

/** Never includes credentials, upstream response bodies, or raw network errors. */
export class EktApiError extends Error {
  readonly code: EktErrorCode;
  readonly status: number | undefined;

  constructor(code: EktErrorCode, message: string, status?: number) {
    super(message);
    this.name = "EktApiError";
    this.code = code;
    this.status = status;
  }
}
