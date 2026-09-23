export interface WebProduct {
  id: number; article: string; name: string; image: string | null; url: string;
  price: number; fresh: boolean; checkedAt: string | null; quantity: number | null; brand: string | null;
  warehouses: { id: number; name: string; quantity: number }[];
  specs: { label: string; value: string; conflict: boolean }[];
  warnings: string[]; reason?: string;
}
export interface Proposal { token: string; product: WebProduct; quantity: number; expiresAt: number }
export interface CartItem { product: WebProduct; quantity: number }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; products?: WebProduct[]; proposal?: Proposal; cartLink?: boolean }
export interface SessionView { messages: ChatMessage[]; cart: CartItem[]; pending: Proposal | null }
