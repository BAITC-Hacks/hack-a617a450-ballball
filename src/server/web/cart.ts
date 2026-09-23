import { randomUUID } from 'node:crypto';
import { getNormalizedProductById } from '../products/index.ts';
import { toWebProduct } from './products.ts';
import type { CartItem, Proposal, WebProduct } from '../../shared/web-types.ts';
export interface CartState { cart: CartItem[]; pending: Proposal | null }
export function propose(state: CartState, product: WebProduct, quantity: number): Proposal {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Укажите целое положительное количество.');
  state.pending = { token: randomUUID(), product, quantity, expiresAt: Date.now() + 5 * 60_000 };
  return state.pending;
}
export async function confirm(state: CartState, token: string, load = getNormalizedProductById): Promise<CartItem> {
  const pending = state.pending;
  if (!pending || pending.token !== token || pending.expiresAt < Date.now()) throw new Error('Подтверждение истекло. Попросите добавить товар ещё раз.');
  // Consume before awaiting: a replay/concurrent confirmation cannot add twice.
  state.pending = null;
  const product = await load(pending.product.id);
  if (product.id !== pending.product.id) throw new Error('Не удалось проверить товар. Повторите запрос.');
  const current = state.cart.find(i => i.product.id === product.id);
  const quantity = (current?.quantity ?? 0) + pending.quantity;
  if (product.totalQuantity === null || quantity > product.totalQuantity) throw new Error(`Недостаточно подтверждённого остатка. Доступно: ${product.totalQuantity ?? 'неизвестно'}. Корзина не изменена.`);
  const item = { product: toWebProduct(product, true), quantity };
  state.cart = [...state.cart.filter(i => i.product.id !== product.id), item];
  return item;
}
