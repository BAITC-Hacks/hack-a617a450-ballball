/** Wire types derived from the two catalog snapshots and detail 515291. */
export interface EktProductSummary {
  id: number;
  name: string;
  article: string;
  /** No currency or tax-inclusion metadata is supplied. */
  price: number;
  image: string | null;
  url: string;
  url_api_detail: string;
  /** All observed arrays are empty; offer elements have no verified schema. */
  offers: unknown[];
}

export interface EktProductsResponse {
  page: number;
  per_page: number;
  count: number;
  items: EktProductSummary[];
}

export interface EktStore {
  id: number;
  name: string;
  quantity: number;
}

/** Values are kept verbatim, including units, leading zeros, and comma decimals. */
export type EktPropertyValue = string | string[];

/** Keys vary by product; observed keys are optional, not universal requirements. */
export interface EktProperties {
  [code: string]: EktPropertyValue | undefined;
  BRAND_PRIORITY?: string;
  CML2_ARTICLE?: string;
  NOVINKA?: string;
  SPETSPREDLOZHENIE?: string;
  RECOMMEND?: string[];
  CML2_BAR_CODE?: string;
  CML2_TRAITS?: string[];
  CML2_TAXES?: string;
  KRATNOST_MIN?: string;
  IMYAKARTINKI?: string;
  ARTIKULPOSTAVSHCHIKA?: string;
  OBYEM?: string;
  KOLICHESTVO_POLYUSOV?: string;
  NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST?: string;
  NOMINALNOE_NAPRYAZHENIE?: string;
  NOMINALNYY_TOK?: string;
  TIP_USTANOVKI?: string;
  TORGOVAYA_MARKA?: string;
}

/** Detail is a bare object, without an envelope or url_api_detail field. */
export interface EktProductDetail extends Omit<EktProductSummary, "url_api_detail"> {
  description: string;
  quantity: number;
  stores: EktStore[];
  properties: EktProperties;
}
