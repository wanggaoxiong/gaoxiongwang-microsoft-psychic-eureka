import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LangCode, LocalizedFields } from '@/lib/i18n/languages';

/**
 * Catalog v1：用本地 JSON 文件做存储，避免 prisma + postgres 启动成本。
 * 等数据量真上去（或多机部署）再迁到现有 prisma schema 的 SupplierProduct 表。
 * 文件路径：<repoRoot>/data/catalog.json
 */
export type CatalogProduct = {
  id: string;
  source: string; // 'gxhyapp' | '1688' | ...
  sourceCode: string;
  sourceUrl: string;
  mainImage: string;
  galleryImages: string[];
  title: string;
  brand: string;
  series: string;
  model: string;
  /** 商家货号；与 brand model 不同 */
  skuCode?: string;
  categoryPath: string[];
  price: string;
  priceNumber: number | null;
  /** 货币代码，例如 CNY / USD / EUR；从 price 推断 */
  currency?: string;
  merchant: string;
  attributes: string[];
  /** 性别：女 / 男 / 中性 / 童 / 未确认 */
  gender?: string;
  /** 颜色数组（主色 + 配色） */
  colors?: string[];
  /** 尺寸数组（cm 或服装码） */
  sizes?: string[];
  /** 材质细分 */
  materials?: string[];
  /** 适用场景，如 通勤·赴约 */
  targetAudience?: string;
  /** 营销卖点 3-5 条，用于话术发送 */
  descriptionBullets?: string[];
  /**
   * AI 提取的检索关键词，混合中英文，用于 AI 话术 / 智能搜索匹配。
   * 例如：['monogram', '老花', 'crossbody', '斜挎', '通勤包']
   */
  searchKeywords?: string[];
  /** 使用场景，如 ['通勤', '商务出差', '日常街拍'] */
  useCase?: string[];
  /** 适合的客户类型，如 ['白领女性', '25-35', '中端价位'] */
  bestForCustomerType?: string[];
  /** 库存状态：true=有货, false=缺货, undefined=未知 */
  inStock?: boolean;
  /** 原始库存文本（例如 "In Stock" / "Out of Stock"） */
  stockText?: string;
  /** 多语言翻译缓存：首次在详情切该语言时产生并永久落盘 */
  localizations?: Partial<Record<LangCode, LocalizedFields>>;
  confidence: number;
  confidenceSource: 'llm' | 'heuristic';
  confidenceNotes?: string;
  createdAt: string;
  updatedAt: string;
};

const STORE_PATH = path.join(process.cwd(), 'data', 'catalog.json');

let writeQueue: Promise<void> = Promise.resolve();

async function ensureFile(): Promise<void> {
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, '[]', 'utf-8');
  }
}

async function readAll(): Promise<CatalogProduct[]> {
  await ensureFile();
  const raw = await fs.readFile(STORE_PATH, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CatalogProduct[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(items: CatalogProduct[]): Promise<void> {
  // 串行写入，避免并发覆盖
  writeQueue = writeQueue.then(async () => {
    await ensureFile();
    await fs.writeFile(STORE_PATH, JSON.stringify(items, null, 2), 'utf-8');
  });
  await writeQueue;
}

function parsePriceNumber(price: string): number | null {
  const m = price?.match(/[\d,.]+/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 从 price 字符串推断货币代码。推不出返回 undefined。 */
export function detectCurrency(price: string | undefined): string | undefined {
  if (!price) return undefined;
  const s = price.trim();
  if (/^(CNY|USD|EUR|JPY|GBP|KRW|HKD|TWD|SGD|AUD|CAD)\b/i.test(s)) {
    return s.slice(0, 3).toUpperCase();
  }
  if (s.startsWith('¥') || s.startsWith('￥')) return 'CNY';
  if (s.startsWith('$')) return 'USD';
  if (s.startsWith('€')) return 'EUR';
  if (s.startsWith('£')) return 'GBP';
  if (s.startsWith('₩')) return 'KRW';
  if (s.startsWith('¥')) return 'JPY';
  return undefined;
}

function genId(source: string, sourceCode: string): string {
  return `${source}_${sourceCode}_${Math.random().toString(36).slice(2, 8)}`;
}

export type ListFilters = {
  q?: string;
  brand?: string;
  source?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: 'newest' | 'price-asc' | 'price-desc';
};

export type ListResult = {
  items: CatalogProduct[];
  total: number;
  brands: Array<{ name: string; count: number }>;
  sources: Array<{ name: string; count: number }>;
  /** 同一 model 出现多件的列表，用于 UI 提示可能重复；key = "brand|model" */
  duplicates?: Record<string, string[]>; // brand|model -> [productId, ...]
};

export async function listProducts(filters: ListFilters = {}): Promise<ListResult> {
  const all = await readAll();
  let items = [...all];

  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter((p) =>
      [p.title, p.brand, p.series, p.model, p.merchant, p.sourceCode, ...p.categoryPath]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q))
    );
  }
  if (filters.brand) {
    items = items.filter((p) => p.brand === filters.brand);
  }
  if (filters.source) {
    items = items.filter((p) => p.source === filters.source);
  }
  if (typeof filters.minPrice === 'number') {
    items = items.filter((p) => (p.priceNumber ?? Infinity) >= filters.minPrice!);
  }
  if (typeof filters.maxPrice === 'number') {
    items = items.filter((p) => (p.priceNumber ?? -Infinity) <= filters.maxPrice!);
  }

  switch (filters.sort) {
    case 'price-asc':
      items.sort((a, b) => (a.priceNumber ?? Infinity) - (b.priceNumber ?? Infinity));
      break;
    case 'price-desc':
      items.sort((a, b) => (b.priceNumber ?? -Infinity) - (a.priceNumber ?? -Infinity));
      break;
    case 'newest':
    default:
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // 聚合所有商品的品牌/来源用于侧边筛选（基于 all，不基于过滤后）
  const brandCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const p of all) {
    if (p.brand && p.brand !== '品牌待确认') {
      brandCounts.set(p.brand, (brandCounts.get(p.brand) ?? 0) + 1);
    }
    sourceCounts.set(p.source, (sourceCounts.get(p.source) ?? 0) + 1);
  }

  // 重复检测：同一 brand+model 出现多件 -> 列出所有商品 id
  const dupMap = new Map<string, string[]>();
  for (const p of all) {
    const m = (p.model || '').trim();
    const b = (p.brand || '').trim();
    if (!m || m === '型号待确认' || !b || b === '品牌待确认') continue;
    const key = `${b}|${m}`;
    const arr = dupMap.get(key) ?? [];
    arr.push(p.id);
    dupMap.set(key, arr);
  }
  const duplicates: Record<string, string[]> = {};
  for (const [k, ids] of dupMap.entries()) {
    if (ids.length > 1) duplicates[k] = ids;
  }

  return {
    items,
    total: items.length,
    brands: Array.from(brandCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    sources: Array.from(sourceCounts.entries()).map(([name, count]) => ({ name, count })),
    duplicates
  };
}

export async function getProduct(id: string): Promise<CatalogProduct | null> {
  const all = await readAll();
  return all.find((p) => p.id === id) ?? null;
}

export type UpsertInput = Omit<CatalogProduct, 'id' | 'priceNumber' | 'createdAt' | 'updatedAt'>;

export async function upsertProduct(input: UpsertInput): Promise<CatalogProduct> {
  const all = await readAll();
  const now = new Date().toISOString();
  const existing = all.find((p) => p.source === input.source && p.sourceCode === input.sourceCode);
  const priceNumber = parsePriceNumber(input.price);
  const currency = input.currency ?? detectCurrency(input.price);

  if (existing) {
    // 保留已有的 localizations（重新提取不该清除翻译缓存）但 zh 变化时该翻译过期
    const prevZhTitle = existing.title;
    const keepLocalizations = input.localizations ?? existing.localizations;
    Object.assign(existing, input, {
      priceNumber,
      currency,
      localizations: keepLocalizations,
      updatedAt: now
    });
    // 如果 title 变了，清除除 zh 之外的译文（避免老译文与新中文不一致）
    if (existing.localizations && input.title && input.title !== prevZhTitle) {
      const fresh: Partial<Record<LangCode, LocalizedFields>> = {};
      if (existing.localizations.zh) fresh.zh = existing.localizations.zh;
      existing.localizations = fresh;
    }
    await writeAll(all);
    return existing;
  }

  const created: CatalogProduct = {
    ...input,
    currency,
    id: genId(input.source, input.sourceCode),
    priceNumber,
    createdAt: now,
    updatedAt: now
  };
  all.unshift(created);
  await writeAll(all);
  return created;
}

export async function deleteProduct(id: string): Promise<boolean> {
  const all = await readAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  await writeAll(all);
  return true;
}

export async function deleteMany(ids: string[]): Promise<number> {
  const all = await readAll();
  const set = new Set(ids);
  const next = all.filter((p) => !set.has(p.id));
  const removed = all.length - next.length;
  if (removed > 0) await writeAll(next);
  return removed;
}

/** 写入指定语言的翻译缓存；返回更新后的商品 */
export async function setProductLocalization(
  id: string,
  lang: LangCode,
  fields: LocalizedFields
): Promise<CatalogProduct | null> {
  const all = await readAll();
  const p = all.find((x) => x.id === id);
  if (!p) return null;
  p.localizations = { ...(p.localizations ?? {}), [lang]: fields };
  p.updatedAt = new Date().toISOString();
  await writeAll(all);
  return p;
}

/**
 * 增量更新元数据：仅写 AI 富化字段 (searchKeywords/useCase/bestForCustomerType)。
 * 用于「补全」既有商品，避免完整重抽。null = 清空，undefined = 不动。
 */
export async function patchProductMetadata(
  id: string,
  patch: Partial<
    Pick<CatalogProduct, 'searchKeywords' | 'useCase' | 'bestForCustomerType'>
  >
): Promise<CatalogProduct | null> {
  const all = await readAll();
  const p = all.find((x) => x.id === id);
  if (!p) return null;
  if (patch.searchKeywords !== undefined) p.searchKeywords = patch.searchKeywords;
  if (patch.useCase !== undefined) p.useCase = patch.useCase;
  if (patch.bestForCustomerType !== undefined) p.bestForCustomerType = patch.bestForCustomerType;
  p.updatedAt = new Date().toISOString();
  await writeAll(all);
  return p;
}
