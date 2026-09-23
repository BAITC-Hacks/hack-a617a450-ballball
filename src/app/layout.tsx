import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'EKT AI — ваш помощник по электротехнике', description: 'Поиск электротехники, характеристики и наличие из каталога EKT.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
