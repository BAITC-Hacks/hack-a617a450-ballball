import type { EktProductDetail, EktProductSummary, EktProperties } from "../ekt/types.ts";

export interface TechnicalCharacteristic {
  code: string;
  value: string;
  source: string;
  /** No automatic conversion into a definitive engineering specification. */
  conflictDetected: boolean;
}

export interface ProductConflict {
  field: string;
  kind: "conflicting-source-values";
  evidence: { source: string; rawValue: string; comparedValue: string }[];
}

export interface Product {
  id: number;
  article: string;
  name: string;
  price: number;
  image: string | null;
  productUrl: string;
  description: string | null;
  totalQuantity: number | null;
  warehouses: { id: number; name: string; quantity: number }[] | null;
  /** Reports aggregate stock only, not sellability or a reservation. */
  stockStatus: "positive" | "zero" | "unknown";
  brand: string | null;
  supplierArticle: string | null;
  barcode: string | null;
  technicalCharacteristics: TechnicalCharacteristic[];
  recommendationReferences: string[];
  properties: EktProperties;
  conflicts: ProductConflict[];
  detailLoaded: boolean;
  /** Snapshots retained separately, including differences between list/detail. */
  raw: { catalog: EktProductSummary | null; detail: EktProductDetail | null };
}

export type MatchKind = "exact-article" | "article-variant" | "partial-article" | "exact-name" |
  "name-phrase" | "name-tokens" | "brand" | "text";

export interface ProductSearchMatch {
  product: Product;
  score: number;
  matchedBy: MatchKind;
}

export interface SearchCoverage {
  cacheLayer?: "memory" | "persistent" | "network";
  catalogStale?: boolean;
  refreshing?: boolean;
  refreshError?: string;
  catalogPages: number;
  catalogProducts: number;
  catalogTermination: "empty-page" | "short-page-wrap" | "page-limit" | "match-found" | "error";
  catalogComplete: boolean;
  catalogSource: "network" | "cached" | "mixed";
  pagesFetched: number;
  nextPage: number | null;
  catalogFetchedAt: string;
  detailedProducts: number;
  /** Detail coverage of the scanned catalog only, not the entire EKT catalog. */
  allScannedProductsDetailed: boolean;
}

export interface ProductSearchResult {
  query: string;
  matches: ProductSearchMatch[];
  coverage: SearchCoverage;
}
