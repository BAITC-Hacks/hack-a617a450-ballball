import type { Product } from '../products/index.ts';
import { getNormalizedProductById, searchProducts } from '../products/index.ts';
import type { WebProduct } from '../../shared/web-types.ts';
const labels: Record<string, string> = {
  NOMINALNYY_TOK: 'Номинальный ток', NOMINALNOE_NAPRYAZHENIE: 'Напряжение',
  KOLICHESTVO_POLYUSOV: 'Количество полюсов', NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: 'Отключающая способность',
  TIP_USTANOVKI: 'Тип установки', STEPEN_ZASHCHITY: 'Степень защиты', TORGOVAYA_MARKA: 'Бренд',
};
function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try { const u = new URL(value, 'https://ekt.kz'); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function toWebProduct(p: Omit<Product, 'raw'>, fresh: boolean): WebProduct {
  return { id: p.id, article: p.article, name: p.name, image: safeUrl(p.image), url: safeUrl(p.productUrl) ?? 'https://ekt.kz',
    price: p.price, fresh, checkedAt: fresh ? new Date().toISOString() : null, quantity: fresh ? p.totalQuantity : null, brand: p.brand,
    warehouses: fresh ? p.warehouses ?? [] : [],
    specs: p.technicalCharacteristics.map(c => ({ label: labels[c.code] ?? c.code.replaceAll('_', ' '), value: c.value, conflict: c.conflictDetected })),
    warnings: p.conflicts.map(c => `Противоречие в данных EKT: ${c.evidence.map(e => `${e.source === 'name' ? 'Название' : e.source === 'description' ? 'Описание' : labels[e.source.replace('properties.', '')] ?? 'Свойство EKT'}: ${e.rawValue}`).join('; ')}. Уточните характеристики перед выбором.`),
  };
}
export async function alternatives(id: number, source = { getNormalizedProductById, searchProducts }): Promise<{ text: string; products: WebProduct[] }> {
  const base = await source.getNormalizedProductById(id);
  const references = [...new Set(base.recommendationReferences.filter(x => /^\d+$/.test(x)).map(Number))].filter(x => x !== id).slice(0, 4);
  async function compare(ids: number[], recommended: boolean): Promise<WebProduct[]> {
    const resolved = await Promise.allSettled(ids.map(source.getNormalizedProductById));
    return resolved.flatMap(result => {
      if (result.status !== 'fulfilled') return [];
      const p = result.value;
      const shared = p.technicalCharacteristics.filter(c => !c.conflictDetected && base.technicalCharacteristics.some(b => !b.conflictDetected && b.code === c.code && b.value.trim().toLowerCase() === c.value.trim().toLowerCase()));
      // Recommendation IDs can be accessories/unrelated goods. They alone do not establish an alternative.
      if (shared.length < 2) return [];
      const different = p.technicalCharacteristics.filter(c => base.technicalCharacteristics.some(b => b.code === c.code && b.value.trim().toLowerCase() !== c.value.trim().toLowerCase()));
      const card = toWebProduct(p, true);
      card.reason = `${recommended ? 'Указан в рекомендациях EKT.' : 'Кандидат из каталога EKT.'} Совпадают: ${shared.slice(0, 4).map(c => `${labels[c.code] ?? c.code}: ${c.value}`).join('; ')}.${different.length ? ` Отличаются: ${different.map(c => `${labels[c.code] ?? c.code}: ${c.value}`).join('; ')}.` : ''} Возможный вариант для сравнения; совместимость и взаимозаменяемость не подтверждены.`;
      return [{ card, score: shared.length }];
    }).sort((a, b) => b.score - a.score || a.card.id - b.card.id).slice(0, 3).map(x => x.card);
  }
  let products = references.length ? await compare(references, true) : [];
  if (!products.length) {
    // A literal series token from the source name improves discovery without inferring specifications.
    const series = base.name.split(/\s+/).find(token => /^[a-z]+[0-9]+/i.test(token));
    const query = series || base.brand || base.name.split(/\s+/).slice(0, 2).join(' ');
    const candidates = (await source.searchProducts(query)).matches.filter(m => m.product.id !== id && !references.includes(m.product.id)).slice(0, 6).map(m => m.product.id);
    products = await compare(candidates, false);
  }
  return { text: `${products.length ? 'Нашёл реальные товары EKT с общими параметрами для сравнения. Это не подтверждённые взаимозаменяемые аналоги.' : 'По доступным данным безопасно определить аналог не удалось. Уточните необходимые параметры у специалиста EKT.'}${base.conflicts.length ? ' У исходного товара есть противоречия в характеристиках — подбор требует проверки.' : ''}`, products };
}
