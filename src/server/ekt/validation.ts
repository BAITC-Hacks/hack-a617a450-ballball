import { EktApiError } from "./errors.ts";
import type { EktProductDetail, EktProductsResponse } from "./types.ts";

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isInteger = (value: unknown): value is number => isAmount(value) && Number.isSafeInteger(value);
const isId = (value: unknown): value is number => isInteger(value) && value > 0;

function isUrl(value: unknown): value is string {
  if (!isString(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function malformed(): never {
  // Do not echo upstream keys or values into logs/errors.
  throw new EktApiError("MALFORMED_RESPONSE", "EKT API response does not match the verified schema or requested resource.", 200);
}

function checkEnvelope(value: unknown): asserts value is ObjectValue {
  if (!isObject(value)) malformed();
  if (Object.hasOwn(value, "error")) {
    if (value.error === "Unauthorized") {
      throw new EktApiError("AUTHENTICATION", "EKT API authentication failed.", 200);
    }
    // Missing-product error text has not been observed: do not guess its meaning.
    throw new EktApiError("API_ERROR", "EKT API returned an error payload.", 200);
  }
}

function isProduct(value: unknown): value is ObjectValue {
  return isObject(value) && isId(value.id) && isString(value.name) &&
    isString(value.article) && isAmount(value.price) &&
    (value.image === null || isUrl(value.image)) && isUrl(value.url) && Array.isArray(value.offers);
}

const scalarProperties = [
  "BRAND_PRIORITY", "CML2_ARTICLE", "NOVINKA", "SPETSPREDLOZHENIE", "CML2_BAR_CODE",
  "CML2_TAXES", "KRATNOST_MIN", "IMYAKARTINKI", "ARTIKULPOSTAVSHCHIKA", "OBYEM",
  "KOLICHESTVO_POLYUSOV", "NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST",
  "NOMINALNOE_NAPRYAZHENIE", "NOMINALNYY_TOK", "TIP_USTANOVKI", "TORGOVAYA_MARKA",
];

export function parseProducts(value: unknown, requestedPage: number): EktProductsResponse {
  checkEnvelope(value);
  if (!isId(value.page) || value.page !== requestedPage || !isId(value.per_page) ||
      !isInteger(value.count) || !Array.isArray(value.items) ||
      value.count !== value.items.length || value.count > value.per_page ||
      !value.items.every(item => isProduct(item) && isUrl(item.url_api_detail))) malformed();
  // Guards validate known fields; extra API fields are preserved, not interpreted.
  return value as unknown as EktProductsResponse;
}

export function parseProductDetail(value: unknown, requestedId: number): EktProductDetail {
  checkEnvelope(value);
  if (!isProduct(value) || value.id !== requestedId || !isString(value.description) ||
      !isAmount(value.quantity) || !Array.isArray(value.stores) ||
      !value.stores.every(store => isObject(store) && isId(store.id) && isString(store.name) && isAmount(store.quantity)) ||
      !isObject(value.properties)) malformed();
  const properties = value.properties;
  if (!Object.values(properties).every(property => isString(property) || isStrings(property)) ||
      !scalarProperties.every(key => !Object.hasOwn(properties, key) || isString(properties[key])) ||
      !["RECOMMEND", "CML2_TRAITS"].every(key => !Object.hasOwn(properties, key) || isStrings(properties[key]))) malformed();
  return value as unknown as EktProductDetail;
}
