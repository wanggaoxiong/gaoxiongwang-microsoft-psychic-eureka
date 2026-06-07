import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 历史发货记录（基于结算清单导入）。
 * AI 在与客户谈报价时可以拉取相似历史票据作为锚点：同一国家、同一线路、相近重量的实际价格。
 * 数据由 scripts/import-shipments.js 生成。
 */
export type Shipment = {
  id: string;
  date: string; // YYYY-MM-DD
  country: string; // ISO 2 字母
  countryName: string;
  service: string; // 账单原始服务名
  carrierId?: string;
  serviceId?: string;
  carrierServiceId?: string; // 形如 'uk-royal:c-line'
  pieces: number;
  actualWeightKg: number | null;
  volumetricWeightKg: number | null;
  chargeableWeightKg: number | null;
  volumeCm3: number | null;
  dimsCm: { L: number; W: number; H: number } | null;
  freightFee: number | null;
  miscFee: number | null;
  packingFee: number;
  totalAmount: number | null;
  pricePerKg: number | null;
  currency: string;
  itemDescription: string;
  postcode: string | null;
  origNo: string | null;
  transNo: string | null;
  source: string;
};

const STORE_PATH = path.join(process.cwd(), 'data', 'shipments-history.json');

let cache: { items: Shipment[]; mtime: number } | null = null;

async function readAll(): Promise<Shipment[]> {
  try {
    const stat = await fs.stat(STORE_PATH);
    if (cache && cache.mtime === stat.mtimeMs) return cache.items;
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const items = JSON.parse(raw) as Shipment[];
    cache = { items, mtime: stat.mtimeMs };
    return items;
  } catch {
    return [];
  }
}

export async function loadShipments(): Promise<Shipment[]> {
  return readAll();
}

export type ShipmentQuery = {
  /** 关键词，匹配 itemDescription / service / countryName */
  q?: string;
  /** ISO 2 国家码 */
  country?: string;
  /** carrier id 或 carrierServiceId（'uk-royal' 或 'uk-royal:c-line'） */
  carrier?: string;
  /** 重量范围（kg）；查询计费重 */
  weightMinKg?: number;
  weightMaxKg?: number;
  /** 日期范围（YYYY-MM-DD） */
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
};

export async function searchShipments(query: ShipmentQuery): Promise<Shipment[]> {
  const items = await readAll();
  const q = query.q?.trim().toLowerCase();
  const carrier = query.carrier?.trim();
  const filtered = items.filter((s) => {
    if (query.country && s.country !== query.country.toUpperCase()) return false;
    if (carrier) {
      if (carrier.includes(':')) {
        if (s.carrierServiceId !== carrier) return false;
      } else if (s.carrierId !== carrier) return false;
    }
    if (query.weightMinKg != null && (s.chargeableWeightKg ?? 0) < query.weightMinKg) return false;
    if (query.weightMaxKg != null && (s.chargeableWeightKg ?? 0) > query.weightMaxKg) return false;
    if (query.dateFrom && s.date < query.dateFrom) return false;
    if (query.dateTo && s.date > query.dateTo) return false;
    if (q) {
      const hay = `${s.itemDescription} ${s.service} ${s.countryName} ${s.country}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => (a.date < b.date ? 1 : -1));
  return query.limit ? filtered.slice(0, query.limit) : filtered;
}

/**
 * 给 AI 报价时调用：返回与目标条件「最像」的历史票（按重量接近度排序）。
 * 适用场景：客户说要发 3 kg 包到英国，AI 拉同国家 ±50% 重量区间的最近 N 票作为参考。
 */
export async function findSimilarShipments(opts: {
  country?: string;
  carrierId?: string;
  weightKg?: number;
  keyword?: string;
  limit?: number;
}): Promise<Array<Shipment & { weightDiff: number }>> {
  const items = await readAll();
  const target = opts.weightKg ?? 0;
  const candidates = items.filter((s) => {
    if (opts.country && s.country !== opts.country.toUpperCase()) return false;
    if (opts.carrierId && s.carrierId !== opts.carrierId) return false;
    if (opts.keyword) {
      const k = opts.keyword.toLowerCase();
      const hay = `${s.itemDescription}`.toLowerCase();
      if (!hay.includes(k)) return false;
    }
    return true;
  });
  const scored = candidates.map((s) => ({
    ...s,
    weightDiff: target > 0 ? Math.abs((s.chargeableWeightKg ?? 0) - target) : 0
  }));
  scored.sort((a, b) => a.weightDiff - b.weightDiff || (a.date < b.date ? 1 : -1));
  return scored.slice(0, opts.limit ?? 5);
}

export type ShipmentStats = {
  total: number;
  byCountry: Array<{ country: string; n: number }>;
  byCarrier: Array<{ carrierId: string; service: string; n: number; medianPricePerKg: number }>;
  totalRevenue: number;
  dateRange: { from: string | null; to: string | null };
};

export async function shipmentStats(): Promise<ShipmentStats> {
  const items = await readAll();
  if (items.length === 0) {
    return {
      total: 0,
      byCountry: [],
      byCarrier: [],
      totalRevenue: 0,
      dateRange: { from: null, to: null }
    };
  }
  const countryCount = new Map<string, number>();
  const carrierBuckets = new Map<string, { service: string; carrierId: string; prices: number[] }>();
  let revenue = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const s of items) {
    if (s.country) countryCount.set(s.country, (countryCount.get(s.country) ?? 0) + 1);
    revenue += s.totalAmount ?? 0;
    if (!from || s.date < from) from = s.date;
    if (!to || s.date > to) to = s.date;
    const key = s.carrierServiceId ?? s.service;
    const bucket = carrierBuckets.get(key) ?? {
      service: s.service,
      carrierId: s.carrierId ?? '',
      prices: []
    };
    if (s.pricePerKg != null) bucket.prices.push(s.pricePerKg);
    carrierBuckets.set(key, bucket);
  }
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  };
  return {
    total: items.length,
    byCountry: [...countryCount.entries()]
      .map(([country, n]) => ({ country, n }))
      .sort((a, b) => b.n - a.n),
    byCarrier: [...carrierBuckets.entries()]
      .map(([_, v]) => ({
        carrierId: v.carrierId,
        service: v.service,
        n: v.prices.length,
        medianPricePerKg: Math.round(median(v.prices) * 100) / 100
      }))
      .sort((a, b) => b.n - a.n),
    totalRevenue: Math.round(revenue * 100) / 100,
    dateRange: { from, to }
  };
}
