import type { Product, ProductSearchMatch } from "./types.ts";

/** Keep punctuation/leading zeros in article numbers; normalize case and whitespace. */
export const normalizeSearchText = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export function rankProduct(product: Product, query: string): ProductSearchMatch | null {
  const q = normalizeSearchText(query);
  if (!q) return null;
  const articles = [product.article, product.supplierArticle, product.properties.CML2_ARTICLE]
    .filter((value): value is string => typeof value === "string" && value.length > 0).map(normalizeSearchText);
  const name = normalizeSearchText(product.name);
  const tokens = q.split(" ");
  const match = (score: number, matchedBy: ProductSearchMatch["matchedBy"]) => ({ product, score, matchedBy });
  if (articles.includes(q)) return match(700, "exact-article");
  if (articles.some(article => article.includes(q))) return match(600, "partial-article");
  if (name === q) return match(500, "exact-name");
  if (name.includes(q)) return match(400, "name-phrase");
  if (tokens.every(token => name.includes(token))) return match(300, "name-tokens");
  if (product.brand && normalizeSearchText(product.brand).includes(q)) return match(200, "brand");
  const text = normalizeSearchText([
    product.name, product.description ?? "", ...Object.values(product.properties).flatMap(value => value ?? []),
  ].join(" "));
  return tokens.every(token => text.includes(token)) ? match(100, "text") : null;
}

/** Stable even when the upstream catalog order changes. */
export function compareMatches(a: ProductSearchMatch, b: ProductSearchMatch): number {
  return b.score - a.score || a.product.id - b.product.id;
}
