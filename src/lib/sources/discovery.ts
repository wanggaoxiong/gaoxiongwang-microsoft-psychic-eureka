/**
 * Source Discovery Pool
 *
 * 不同 source connector (gxhyapp / 1688 / 微商相册 ...) 在批量"扫描"时
 * 会沿着商家页 / 系列页 / 搜索结果页爬取商品链接 + 主图 + 基础信息，
 * 把这些"候选商品"存到 data/source-discoveries.json，作为 Catalog 的预选池。
 *
 * 用户在 Catalog 想"添加商品"时，可以：
 *   1) 直接粘贴 URL/code → /api/suppliers/scrape 走单条详情归一化
 *   2) 在 /sources/[id]/discoveries 浏览发现池，一键加入 Catalog
 *
 * 这里只做存储 + 简单查询；爬虫 mock 在 /api/sources/[id]/discover 完成。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DiscoveryEnriched = {
  title?: string;
  brand?: string;
  series?: string;
  model?: string;
  mainImage?: string;
  galleryImages?: string[];
  price?: string;
  categoryPath?: string[];
  merchant?: string;
  descriptionBullets?: string[];
  searchKeywords?: string[];
  useCase?: string[];
  bestForCustomerType?: string[];
  /** 归一化完成时间 */
  normalizedAt?: string;
  /** llm | heuristic */
  confidenceSource?: 'llm' | 'heuristic';
  /** 0..1 */
  confidenceOverall?: number;
};

export type DiscoveredProduct = {
  id: string; // `${sourceId}:${sourceCode}`
  sourceId: string; // 'gxhyapp' | ...
  sourceCode: string; // 货源系统内的商品 code
  detailUrl: string;
  mainImage: string;
  title?: string;
  price?: string;
  merchant?: string;
  brandHint?: string;
  categoryHint?: string;
  discoveredAt: string;
  /** 单调递增序号，用于稳定排序（大的在前） */
  seq?: number;
  /** 已经被加入 Catalog 后的 product id；undefined 表示还在候选池里 */
  catalogProductId?: string;
  /** 加入 / 覆盖 Catalog 的时间戳；用于和 enriched.normalizedAt 比较，决定按钮是否可重复入库 */
  catalogAddedAt?: string;
  /** AI 归一化后的结果快照 */
  enriched?: DiscoveryEnriched;
};

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE = path.join(DATA_DIR, 'source-discoveries.json');

type Store = { items: DiscoveredProduct[] };

let writeChain: Promise<void> = Promise.resolve();

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readStore(): Promise<Store> {
  try {
    const buf = await readFile(STORE, 'utf-8');
    const parsed = JSON.parse(buf);
    if (parsed && Array.isArray(parsed.items)) return parsed as Store;
  } catch {
    /* ignore */
  }
  return { items: [] };
}

async function writeStore(store: Store): Promise<void> {
  await ensureDir();
  await writeFile(STORE, JSON.stringify(store, null, 2), 'utf-8');
}

function enqueueWrite(mutator: (store: Store) => void | Promise<void>): Promise<void> {
  const next = writeChain.then(async () => {
    const store = await readStore();
    await mutator(store);
    await writeStore(store);
  });
  writeChain = next.catch(() => {});
  return next;
}

export async function listDiscoveries(sourceId?: string): Promise<DiscoveredProduct[]> {
  const store = await readStore();
  const items = sourceId ? store.items.filter((it) => it.sourceId === sourceId) : store.items;
  return items.slice().sort((a, b) => {
    // 优先按 sourceCode 数字降序：与原站 "最新在前 / 编号大的在前" 一致，
    // 避免不同批次扫描导致的乱序。非数字 code 退回到 seq / discoveredAt。
    const na = Number(a.sourceCode);
    const nb = Number(b.sourceCode);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
    const sa = a.seq ?? 0;
    const sb = b.seq ?? 0;
    if (sa !== sb) return sb - sa;
    return a.discoveredAt < b.discoveredAt ? 1 : -1;
  });
}

export async function countBySource(sourceId: string): Promise<{ total: number; pending: number }> {
  const store = await readStore();
  const subset = store.items.filter((it) => it.sourceId === sourceId);
  return {
    total: subset.length,
    pending: subset.filter((it) => !it.catalogProductId).length
  };
}

export async function appendDiscoveries(items: DiscoveredProduct[]): Promise<number> {
  let added = 0;
  await enqueueWrite((store) => {
    const seen = new Set(store.items.map((i) => i.id));
    let nextSeq = store.items.reduce((m, i) => Math.max(m, i.seq ?? 0), 0);
    // 传入顺序 = 页面从上到下；希望页面顶部商品出现在发现池首位。
    // 排序号 desc 显示，所以顶部商品需要拿最大的 seq → 倒着分配。
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (seen.has(it.id)) continue;
      nextSeq += 1;
      store.items.push({ ...it, seq: nextSeq });
      seen.add(it.id);
      added += 1;
    }
  });
  return added;
}

export async function updateDiscovery(
  id: string,
  patch: Partial<Pick<DiscoveredProduct, 'enriched' | 'mainImage' | 'title' | 'price' | 'merchant' | 'brandHint' | 'categoryHint'>>
): Promise<DiscoveredProduct | null> {
  let updated: DiscoveredProduct | null = null;
  await enqueueWrite((store) => {
    const item = store.items.find((i) => i.id === id);
    if (!item) return;
    Object.assign(item, patch);
    updated = item;
  });
  return updated;
}

export async function markPromoted(id: string, catalogProductId: string): Promise<void> {
  await enqueueWrite((store) => {
    const item = store.items.find((i) => i.id === id);
    if (item) {
      item.catalogProductId = catalogProductId;
      item.catalogAddedAt = new Date().toISOString();
    }
  });
}

export async function deleteDiscovery(id: string): Promise<void> {
  await enqueueWrite((store) => {
    const idx = store.items.findIndex((i) => i.id === id);
    if (idx >= 0) store.items.splice(idx, 1);
  });
}

export async function clearDiscoveries(sourceId: string): Promise<number> {
  let removed = 0;
  await enqueueWrite((store) => {
    const before = store.items.length;
    store.items = store.items.filter((i) => i.sourceId !== sourceId);
    removed = before - store.items.length;
  });
  return removed;
}
