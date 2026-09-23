import type { EktProductDetail, EktProductSummary } from "../ekt/types.ts";
import type { Product, ProductConflict } from "./types.ts";

const technicalCodes = [
  "KOLICHESTVO_POLYUSOV", "NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST",
  "NOMINALNOE_NAPRYAZHENIE", "NOMINALNYY_TOK", "TIP_USTANOVKI",
] as const;

/** Conservative warning detector, not a general specification extractor. */
function currentConflict(detail: EktProductDetail): ProductConflict[] {
  const property = detail.properties.NOMINALNYY_TOK;
  if (property === undefined) return [];
  const evidence: ProductConflict["evidence"] = [];
  const collect = (text: string, source: string, rawValue = text) => {
    // Match plain A/А, not kA/мА or a number embedded in an identifier.
    for (const match of text.matchAll(/(?<![\p{L}\p{N}.,])([0-9]+(?:[.,][0-9]+)?)\s*[AА](?![\p{L}\p{N}])/gu)) {
      evidence.push({ source, rawValue, comparedValue: `${Number(match[1]!.replace(",", "."))} A` });
    }
  };
  collect(property, "properties.NOMINALNYY_TOK");
  if (evidence.length === 0) return [];
  collect(detail.name, "name");
  for (const match of detail.description.matchAll(/Номинальный\s+ток\s*:\s*([^\r\n]+)/giu)) {
    collect(match[1]!, "description", match[0]);
  }
  return new Set(evidence.map(item => item.comparedValue)).size > 1
    ? [{ field: "NOMINALNYY_TOK", kind: "conflicting-source-values", evidence }]
    : [];
}

/** Accepts validated EKT data; never derives stock or brand from offers/name. */
export function normalizeProduct(source: EktProductSummary | EktProductDetail, catalog?: EktProductSummary): Product {
  const detail = "properties" in source ? structuredClone(source) : null;
  const summary = detail ? (catalog ? structuredClone(catalog) : null) : structuredClone(source as EktProductSummary);
  if (summary && summary.id !== source.id) throw new Error("Catalog and detail IDs must match.");
  const properties = detail?.properties ?? {};
  const conflicts = detail ? currentConflict(detail) : [];
  const quantity = detail?.quantity ?? null;
  return {
    id: source.id, article: source.article, name: source.name, price: source.price,
    image: source.image, productUrl: source.url,
    description: detail?.description ?? null,
    totalQuantity: quantity,
    warehouses: detail ? structuredClone(detail.stores) : null,
    stockStatus: quantity === null ? "unknown" : quantity > 0 ? "positive" : "zero",
    brand: properties.TORGOVAYA_MARKA ?? null,
    supplierArticle: properties.ARTIKULPOSTAVSHCHIKA ?? null,
    barcode: properties.CML2_BAR_CODE ?? null,
    technicalCharacteristics: technicalCodes.flatMap(code => {
      const value = properties[code];
      return value === undefined ? [] : [{ code, value, source: `properties.${code}`, conflictDetected: conflicts.some(c => c.field === code) }];
    }),
    recommendationReferences: [...(properties.RECOMMEND ?? [])],
    properties: structuredClone(properties), conflicts, detailLoaded: detail !== null,
    raw: { catalog: summary, detail },
  };
}
