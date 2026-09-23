import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { createAssistant } from '../assistant/index.ts';
import { containsCardNumber, createRedactor } from '../assistant/security.ts';
import { findProductByArticle, getNormalizedProductById } from '../products/index.ts';
import { alternatives, toWebProduct } from './products.ts';
import { policyAnswer } from './policy.ts';
import { propose, confirm } from './cart.ts';
import type { CartState } from './cart.ts';
import type { ChatMessage, WebProduct, SessionView } from '../../shared/web-types.ts';
interface Session extends CartState { assistant: ReturnType<typeof createAssistant>; messages: ChatMessage[]; selected: WebProduct | null; touched: number; busy: boolean }
const globalStore = globalThis as typeof globalThis & { ektSessions?: Map<string, Session> };
const sessions = globalStore.ektSessions ??= new Map();
export async function session(): Promise<Session> {
  const jar = await cookies();
  const now = Date.now();
  for (const [key, value] of sessions) if (now - value.touched > 2 * 60 * 60_000 && !value.busy) sessions.delete(key);
  let id = jar.get('ekt-demo-session')?.value;
  let found = id ? sessions.get(id) : undefined;
  if (!found) {
    if (sessions.size >= 200) throw new Error('Сервис занят. Попробуйте позже.');
    id = randomUUID();
    found = { assistant: createAssistant(), messages: [], selected: null, touched: now, busy: false, cart: [], pending: null };
    sessions.set(id, found);
    jar.set('ekt-demo-session', id, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 7200 });
  }
  found.touched = now;
  return found;
}
export function view(s: Session): SessionView { return { messages: s.messages, cart: s.cart, pending: s.pending }; }
export async function locked<T>(s: Session, work: () => Promise<T>): Promise<T> {
  if (s.busy) throw new Error('Дождитесь ответа на предыдущий запрос.');
  s.busy = true; try { return await work(); } finally { s.busy = false; }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== request.headers.get('host')) throw new Error('Обновите страницу и повторите запрос.');
}
function append(s: Session, role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}) {
  const message = { id: randomUUID(), role, text, ...extra };
  s.messages = [...s.messages, message].slice(-40);
  return message;
}
async function resolveProduct(s: Session, message: string): Promise<WebProduct | null> {
  const id = message.match(/\bID\s*[:#]?\s*(\d+)/i)?.[1];
  if (id) return toWebProduct(await getNormalizedProductById(Number(id)), true);
  const article = message.match(/(?:артикул\w*\s*[:№]?\s*|\b)(\d{7,}_?)(?!\d)/i)?.[1];
  if (article) {
    const found = await findProductByArticle(article);
    if (found.matches.length === 1) return toWebProduct(found.matches[0]!.product, false);
    return null;
  }
  return s.selected;
}
export async function chat(s: Session, raw: string) {
  if (!raw.trim() || raw.length > 4000) throw new Error('Введите сообщение до 4000 символов.');
  if (containsCardNumber(raw)) return append(s, 'assistant', 'Не отправляйте данные банковской карты. Сообщение не сохранено и не передано модели.');
  const message = createRedactor()(raw.trim());
  append(s, 'user', message);
  let answer: ChatMessage;
  if (/^(да[,!\s]*добавь[.!]?|подтверждаю[.!]?|yes[,!\s]*add[.!]?)$/i.test(message)) {
    if (!s.pending) answer = append(s, 'assistant', 'Нет ожидающего подтверждения. Сначала выберите товар и количество.');
    else {
      await confirm(s, s.pending.token);
      answer = append(s, 'assistant', 'Товар добавлен в демо-корзину. Это не заказ EKT; товар не зарезервирован.', { cartLink: true });
    }
  } else {
    s.pending = null;
    if (/добав[ьи]|add\b/i.test(message)) {
      const product = await resolveProduct(s, message);
      const qty = Number(message.match(/(?:добав[ьи]|add)\s+(\d+)\b/i)?.[1] ?? message.match(/\b(\d+)\s*(?:шт|единиц|pieces)/i)?.[1] ?? 1);
      if (!product) answer = append(s, 'assistant', 'Укажите артикул товара или выберите «В корзину» на карточке. Затем я попрошу подтвердить количество.');
      else { const proposal = propose(s, product, qty); answer = append(s, 'assistant', `Добавить ${qty} шт. «${product.name}» в демо-корзину? До подтверждения корзина не изменится.`, { proposal }); }
    } else if (/аналог|альтернатив|замен[ау]|alternative/i.test(message)) {
      const product = await resolveProduct(s, message);
      if (!product) answer = append(s, 'assistant', 'Сначала найдите исходный товар или укажите его артикул для подбора.');
      else { const found = await alternatives(product.id); answer = append(s, 'assistant', found.text, { products: found.products }); }
    } else {
      const policy = policyAnswer(message);
      if (policy) answer = append(s, 'assistant', policy);
      else {
        const response = await s.assistant.send(message);
        const products = response.products?.map(e => toWebProduct(e.product, e.fresh));
        if (products?.length === 1) s.selected = products[0]!;
        else if (products && products.length > 1) s.selected = null;
        // Coverage stays in the backend; customer-visible freshness is on each card.
        let text = response.text.split('\n').filter(line => !/^(Охват поиска|Search coverage|Іздеу қамтуы)/.test(line)).join('\n').trim();
        if (products?.length) {
          if (/сертификат|certificate/i.test(message)) text = 'Сведения о сертификатах отсутствуют в полученных данных EKT. Подтвердить наличие или предоставить документ нельзя — уточните у EKT.';
          else if (/налич|остат|склад|stock/i.test(message)) text = products.some(p => p.fresh) ? 'Проверил актуальные данные EKT. Остатки и разбивка по складам — в карточке ниже. Это учётные остатки, а не резерв или гарантия продажи.' : 'Товар найден. Актуальный остаток пока не подтверждён; повторите проверку наличия.';
          else if (/характеристик|specification/i.test(message)) text = 'Характеристики из данных EKT — в карточке ниже. Если значения противоречат друг другу, предупреждение показано отдельно.';
          else if (/найди|найти|покажи товар|find|search/i.test(message)) text = 'Нашёл товары в каталоге EKT. Выберите карточку, чтобы проверить актуальное наличие и детали.';
          const requested = message.match(/\b(\d{7,})(?![\d_])/u)?.[1];
          if (requested && products.some(p => p.article === `${requested}_`)) text += '\nОбратите внимание: в EKT артикул заканчивается символом «_». Это возможное совпадение, а не точное равенство введённому артикулу.';
        }
        return append(s, 'assistant', text, { products });
      }
    }
  }
  s.assistant.remember(message, answer.text + (answer.products ?? []).map(p => `\n${p.name} [ID ${p.id}], артикул ${p.article}`).join(''));
  return answer;
}
export async function cartAction(s: Session, body: Record<string, unknown>) {
  if (body.action === 'propose' && Number.isSafeInteger(body.id) && Number.isSafeInteger(body.quantity)) {
    const product = toWebProduct(await getNormalizedProductById(body.id as number), true);
    s.selected = product;
    const proposal = propose(s, product, body.quantity as number);
    append(s, 'assistant', `Добавить ${proposal.quantity} шт. «${product.name}» в демо-корзину? Подтвердите действие.`, { proposal });
  } else if (body.action === 'confirm' && typeof body.token === 'string') {
    await confirm(s, body.token);
    append(s, 'assistant', 'Товар добавлен в демо-корзину. Заказ не оформлен, остаток не зарезервирован.', { cartLink: true });
  } else if (body.action === 'remove' && Number.isSafeInteger(body.id)) {
    s.cart = s.cart.filter(i => i.product.id !== body.id); s.pending = null;
  } else if (body.action === 'cancel') s.pending = null;
  else throw new Error('Не удалось выполнить действие. Повторите запрос.');
  return view(s);
}
export function friendlyError(error: unknown): string {
  const allowed = ['Подтверждение истекло', 'Недостаточно подтверждённого остатка', 'Укажите целое', 'Дождитесь ответа', 'Введите сообщение', 'Нет ожидающего'];
  return error instanceof Error && allowed.some(s => error.message.startsWith(s)) ? error.message : 'Не удалось получить ответ. Попробуйте ещё раз через несколько секунд.';
}
