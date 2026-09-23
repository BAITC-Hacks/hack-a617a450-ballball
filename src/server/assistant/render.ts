import type { Product, SearchCoverage } from "../products/index.ts";
import type { AnswerPlan } from "./protocol.ts";
import type { Language } from "./contracts.ts";

const labels = {
  en: {
    greeting: "Hello! I can search the EKT catalog. Please provide a product name or article.",
    clarify: "Please specify the product name, article, or ID. If several products were discussed, specify which one.",
    missing: "The requested information is unavailable in the retrieved EKT data.",
    certificates: "Certificate information is unavailable in the retrieved EKT data; I cannot confirm a certificate exists.",
    policy: "Authoritative payment, delivery, and minimum-order information is unavailable.",
    cart: "Cart operations are not implemented. Nothing has been added to a cart.",
    compatibility: "These are catalog matches only. Technical compatibility or suitability as a substitute has not been verified.",
    noResults: "No matches were returned in the searched portion of the catalog. This does not establish global absence.",
    error: "Product data could not be retrieved. Please try again; this does not mean the product is unavailable.",
    article: "Article", price: "Price", currency: "currency not supplied", stock: "Reported total quantity",
    stockNote: "Reported inventory only; sale eligibility and reservation are not confirmed.", warehouses: "Warehouses",
    unknown: "unavailable / unknown", specs: "Characteristics as reported by EKT", description: "EKT description (source text)",
    brand: "Brand", supplierArticle: "Supplier article", barcode: "Barcode", references: "Recommendation references (not verified alternatives)",
    conflict: "EKT source data conflicts. Do not choose one value; verify with EKT before selecting this product.",
    coverage: "Search coverage (pages / products / detailed products)", limited: "Coverage may be incomplete; search prices and stock may be cached.",
  },
  ru: {
    greeting: "Здравствуйте! Я помогу найти товары в каталоге EKT. Укажите название или артикул.",
    clarify: "Уточните название, артикул или ID товара. Если обсуждалось несколько товаров, укажите какой именно.",
    missing: "Запрошенная информация отсутствует в полученных данных EKT.",
    certificates: "Сведения о сертификате отсутствуют в полученных данных EKT; подтвердить его наличие нельзя.",
    policy: "Авторитетные сведения об оплате, доставке и минимальном заказе недоступны.",
    cart: "Работа с корзиной ещё не реализована. Ничего не добавлено в корзину.",
    compatibility: "Это только результаты поиска по каталогу. Совместимость и пригодность для замены не подтверждены.",
    noResults: "В просмотренной части каталога совпадений нет. Это не означает отсутствие товара во всём каталоге.",
    error: "Не удалось получить данные о товаре. Попробуйте позже; это не означает, что товара нет в наличии.",
    article: "Артикул", price: "Цена", currency: "валюта не указана", stock: "Общее количество по данным EKT",
    stockNote: "Это учётный остаток; возможность продажи и резервирование не подтверждены.", warehouses: "Склады",
    unknown: "нет данных / неизвестно", specs: "Характеристики по данным EKT", description: "Описание EKT (исходный текст)",
    brand: "Бренд", supplierArticle: "Артикул поставщика", barcode: "Штрихкод", references: "Ссылки рекомендаций (не подтверждённые аналоги)",
    conflict: "Данные источника EKT противоречат друг другу. Нельзя выбрать одно значение; уточните у EKT перед подбором товара.",
    coverage: "Охват поиска (страницы / товары / товары с подробностями)", limited: "Охват может быть неполным; цены и остатки поиска могут быть из кеша.",
  },
  kk: {
    greeting: "Сәлеметсіз бе! EKT каталогынан тауар іздеуге көмектесемін. Атауын немесе артикулын жазыңыз.",
    clarify: "Тауардың атауын, артикулын немесе ID нөмірін нақтылаңыз. Бірнеше тауар талқыланса, қайсысы екенін көрсетіңіз.",
    missing: "Сұралған ақпарат алынған EKT деректерінде жоқ.",
    certificates: "Алынған EKT деректерінде сертификат туралы ақпарат жоқ; оның бар екенін растай алмаймын.",
    policy: "Төлем, жеткізу және ең аз тапсырыс туралы сенімді ақпарат қолжетімсіз.",
    cart: "Себетпен жұмыс әлі іске қосылмаған. Себетке ештеңе қосылған жоқ.",
    compatibility: "Бұлар тек каталогтағы іздеу нәтижелері. Үйлесімділігі немесе алмастыруға жарамдылығы расталмаған.",
    noResults: "Каталогтың қаралған бөлігінде сәйкестік табылмады. Бұл тауардың бүкіл каталогта жоқ екенін білдірмейді.",
    error: "Тауар деректерін алу мүмкін болмады. Кейінірек қайталаңыз; бұл тауар қорда жоқ дегенді білдірмейді.",
    article: "Артикул", price: "Баға", currency: "валюта көрсетілмеген", stock: "EKT деректеріндегі жалпы саны",
    stockNote: "Бұл есептік қор; сатуға қолжетімділігі мен резерві расталмаған.", warehouses: "Қоймалар",
    unknown: "дерек жоқ / белгісіз", specs: "EKT деректеріндегі сипаттамалар", description: "EKT сипаттамасы (бастапқы мәтін)",
    brand: "Бренд", supplierArticle: "Жеткізуші артикулы", barcode: "Штрихкод", references: "Ұсыным сілтемелері (расталған баламалар емес)",
    conflict: "EKT деректері бір-біріне қайшы. Бір мәнді таңдау мүмкін емес; тауарды таңдаудан бұрын EKT арқылы нақтылаңыз.",
    coverage: "Іздеу қамтуы (беттер / тауарлар / толық дерегі бар тауарлар)", limited: "Қамту толық болмауы мүмкін; іздеудегі баға мен қор кештен алынуы мүмкін.",
  },
} as const;

export interface Evidence { product: Product; fresh: boolean; articleVariant?: boolean }
export function renderAnswer(plan: AnswerPlan, evidence: Map<number, Evidence>, coverage: SearchCoverage[], toolError: boolean, policy: { text: string; sourceUrl: string } | null = null): string {
  const l = labels[plan.language];
  const lines: string[] = [];
  if (plan.intent === "greeting") lines.push(l.greeting);
  if (plan.intent === "clarify") lines.push(l.clarify);
  if (plan.intent === "unavailable") lines.push(toolError ? l.error : l.missing);
  const messages = new Set(plan.notices);
  if (plan.intent === "cart") messages.add("cart");
  if (plan.intent === "policy") messages.add("policy");
  if (plan.intent === "certificates") messages.add("certificates");
  if (plan.intent === "alternatives") messages.add("compatibility");
  if (policy) { messages.delete("policy"); lines.push(policy.text, policy.sourceUrl); }
  for (const notice of messages) lines.push(l[notice]);
  if (plan.intent === "products" && plan.productIds.length === 0) lines.push(toolError ? l.error : coverage.length ? l.noResults : l.missing);
  for (const id of [...new Set(plan.productIds)]) {
    const { product: p, fresh, articleVariant } = evidence.get(id)!;
    lines.push(`\n${p.name} [ID ${p.id}]`, `${l.article}: ${p.article}`, p.productUrl);
    if (articleVariant) lines.push({
      en: "Candidate only: the stored article includes a trailing underscore and is not an exact match to your input.",
      ru: "Возможное совпадение: артикул в каталоге содержит завершающий символ подчёркивания и не равен введённому артикулу.",
      kk: "Ықтимал сәйкестік: каталогтағы артикул соңында астын сызу белгісі бар, енгізілген артикулмен дәл сәйкес емес.",
    }[plan.language]);
    // Conflicts are mandatory, even if the model omits specifications from fields.
    if (p.conflicts.length) {
      lines.push(l.conflict);
      for (const conflict of p.conflicts) for (const entry of conflict.evidence) {
        lines.push(`${conflict.field} — ${entry.source}: ${entry.rawValue} [${entry.comparedValue}]`);
      }
    }
    for (const field of new Set(plan.fields)) {
      if (field === "price") lines.push(`${l.price}: ${p.price} (${l.currency})${fresh ? "" : { en: " — catalog snapshot, not a current quote", ru: " — снимок каталога, не текущая цена", kk: " — каталог көшірмесіндегі баға, ағымдағы баға емес" }[plan.language]}`);
      else if (field === "stock") {
        lines.push(`${l.stock}: ${fresh && p.totalQuantity !== null ? p.totalQuantity : l.unknown}`);
        if (fresh && p.warehouses !== null) lines.push(`${l.warehouses}:`, ...p.warehouses.map(s => `${s.name} [${s.id}]: ${s.quantity}`));
        lines.push(l.stockNote);
      } else if (field === "specifications") {
        lines.push(`${l.specs}:`, ...(p.technicalCharacteristics.length ? p.technicalCharacteristics.map(c => `${c.code}: ${c.value} (${c.source})`) : [l.unknown]));
      } else if (field === "description") lines.push(`${l.description}: ${p.description ?? l.unknown}`);
      else if (field === "references") lines.push(`${l.references}: ${p.recommendationReferences.length ? p.recommendationReferences.join(", ") : l.unknown}`);
      else lines.push(`${l[field]}: ${p[field] ?? l.unknown}`);
    }
  }
  for (const c of coverage) {
    if (c.catalogStale) lines.push({ en: "The discovery index is stale; current facts require fresh details.", ru: "Поисковый индекс устарел; актуальные сведения требуют нового запроса деталей.", kk: "Іздеу индексі ескірген; ағымдағы ақпарат үшін жаңа деректер қажет." }[plan.language]);
    const status = {
      en: c.catalogComplete ? "Catalog summary scan complete." : "Partial catalog scan.",
      ru: c.catalogComplete ? "Все страницы каталога просмотрены." : "Каталог просмотрен частично.",
      kk: c.catalogComplete ? "Каталогтың барлық беттері қаралды." : "Каталог ішінара қаралды.",
    }[plan.language];
    const source = {
      network: { en: "Data loaded from EKT.", ru: "Данные загружены из EKT.", kk: "Деректер EKT жүйесінен алынды." },
      cached: { en: "Cached catalog data.", ru: "Данные каталога из кеша.", kk: "Каталог деректері кештен алынды." },
      mixed: { en: "Cached catalog extended with EKT data.", ru: "Кеш каталога дополнен данными EKT.", kk: "Кеш EKT деректерімен толықтырылды." },
    }[c.catalogSource][plan.language];
    lines.push(`\n${l.coverage}: ${c.catalogPages} / ${c.catalogProducts} / ${c.detailedProducts}. ${status} ${source} ${l.limited}`);
  }
  return lines.join("\n") || l.missing;
}
export function cardWarning(language: Language = "ru"): string {
  return { ru: "Не отправляйте данные банковской карты. Сообщение не сохранено и не передано модели.", en: "Do not send payment-card information. This message was not stored or sent to the model.", kk: "Банк картасының деректерін жібермеңіз. Хабарлама сақталмады және модельге жіберілмеді." }[language];
}
