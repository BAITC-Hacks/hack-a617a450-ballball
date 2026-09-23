'use client';
import { useState } from 'react';
import { ArrowUpRight, Box, Check, ShoppingCart, AlertTriangle } from 'lucide-react';
import type { WebProduct } from '../shared/web-types';
export const money = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
export function ProductImage({ product }: { product: WebProduct }) {
  const [failed, setFailed] = useState(false);
  return <div className="product-image">{product.image && !failed ? <img src={product.image} alt={product.name} onError={() => setFailed(true)} /> : <Box size={46} strokeWidth={1} />}</div>;
}
export function ProductCard({ product: p, onAdd, onAsk, disabled }: { product: WebProduct; onAdd: (id: number, qty: number) => void; onAsk: (text: string) => void; disabled: boolean }) {
  const [quantity, setQuantity] = useState(1);
  return <article className="product-card">
    <div className="product-top"><ProductImage product={p} /><div className="product-heading"><div className="eyebrow">{p.brand || 'КАТАЛОГ EKT'}</div><h3>{p.name}</h3><span className="article">Артикул {p.article}</span><a href={p.url} target="_blank" rel="noreferrer">На ekt.kz <ArrowUpRight size={14} /></a></div></div>
    {p.checkedAt && <p className="verified-at">Данные проверены в {new Date(p.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</p>}
    {p.reason && <p className="reason">{p.reason}</p>}
    <div className="product-facts"><div><strong className="price">{money(p.price)}</strong><span className="muted tiny">{p.fresh ? 'Цена из EKT · валюта не указана' : 'Цена из снимка каталога · валюта не указана'}</span></div><div className={`stock ${p.quantity !== null && p.quantity > 0 ? 'available' : ''}`}>{p.quantity === null ? <><Box size={14} /> Наличие не проверено</> : <><Check size={14} /> Остаток: {money(p.quantity)} шт.</>}</div></div>
    {p.specs.length > 0 && <dl className="specs">{p.specs.map((s, i) => <div key={i}><dt>{s.label}</dt><dd>{s.value}{s.conflict ? ' ⚠' : ''}</dd></div>)}</dl>}
    {p.warehouses.length > 0 && <details className="warehouse"><summary>Наличие на складах · {p.warehouses.length}</summary>{p.warehouses.map(w => <div key={w.id}><span>{w.name}</span><strong>{money(w.quantity)} шт.</strong></div>)}</details>}
    {p.warnings.map((w, i) => <div className="warning" key={i}><AlertTriangle size={16} /><span>{w}</span></div>)}
    <div className="product-actions"><button className="text-button" disabled={disabled} onClick={() => onAsk(`Проверь актуальные остатки и характеристики товара ID ${p.id}`)}>Подробнее</button><div className="add-controls"><input aria-label={`Количество ${p.article}`} type="number" min="1" max="1000000" step="1" value={quantity} onChange={e => setQuantity(Number(e.target.value))} /><button className="dark-button" disabled={disabled || !Number.isSafeInteger(quantity) || quantity < 1} onClick={() => onAdd(p.id, quantity)}><ShoppingCart size={15} /> В корзину</button></div></div>
  </article>;
}
