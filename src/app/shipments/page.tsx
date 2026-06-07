'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Input, Select } from '@/lib/ui/primitives';
import type { Shipment } from '@/lib/shipments/store';

type Stats = {
  total: number;
  byCountry: Array<{ country: string; n: number }>;
  byCarrier: Array<{ carrierId: string; service: string; n: number; medianPricePerKg: number }>;
  totalRevenue: number;
  dateRange: { from: string | null; to: string | null };
};

export default function ShipmentsPage() {
  const [items, setItems] = useState<Shipment[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [carrier, setCarrier] = useState('');
  const [weightMin, setWeightMin] = useState('');
  const [weightMax, setWeightMax] = useState('');

  useEffect(() => {
    fetch('/api/shipments?stats=1', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => j.ok && setStats(j.stats))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (country) params.set('country', country);
    if (carrier) params.set('carrier', carrier);
    if (weightMin) params.set('weightMin', weightMin);
    if (weightMax) params.set('weightMax', weightMax);
    params.set('limit', '300');
    setLoading(true);
    fetch(`/api/shipments?${params.toString()}`, { signal: ctrl.signal, cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setItems(j.items);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [q, country, carrier, weightMin, weightMax]);

  const countryOpts = useMemo(
    () => stats?.byCountry.map((c) => c.country).filter(Boolean) ?? [],
    [stats]
  );
  const carrierOpts = useMemo(
    () =>
      Array.from(
        new Set(stats?.byCarrier.map((c) => c.carrierId).filter(Boolean) ?? [])
      ).sort(),
    [stats]
  );

  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="border-b border-zinc-200 bg-white">
        <div className="mx-auto max-w-7xl px-8 py-6">
          <h1 className="text-2xl font-semibold text-zinc-900">发货历史</h1>
          <p className="mt-1 text-sm text-zinc-500">
            真实结算清单导入，作为 AI 报价时的检索锚点。同国家 + 相近重量的历史票，就是最可信的参考价。
          </p>
          {stats ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="总票数" value={`${stats.total} 票`} />
              <StatCard
                label="总应收 (CNY)"
                value={`¥${stats.totalRevenue.toLocaleString()}`}
              />
              <StatCard
                label="时间区间"
                value={
                  stats.dateRange.from
                    ? `${stats.dateRange.from} → ${stats.dateRange.to}`
                    : '—'
                }
              />
              <StatCard label="出口国家数" value={`${stats.byCountry.length} 个`} />
            </div>
          ) : null}
          {stats ? (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <MiniTable
                title="国家 Top 10"
                rows={stats.byCountry.slice(0, 10).map((c) => [c.country || '—', `${c.n} 票`])}
              />
              <MiniTable
                title="线路（中位 ¥/kg）"
                rows={stats.byCarrier
                  .slice(0, 10)
                  .map((c) => [c.service, `${c.n} 票 · ¥${c.medianPricePerKg}/kg`])}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-8 py-6">
        <Card className="p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Filter label="关键词 (商品/线路)">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="手提包 / 男士外套 …" />
            </Filter>
            <Filter label="目的国家">
              <Select value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="">全部</option>
                {countryOpts.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Filter>
            <Filter label="承运商">
              <Select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                <option value="">全部</option>
                {carrierOpts.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Filter>
            <Filter label="计费重 ≥ (kg)">
              <Input
                type="number"
                step="0.1"
                value={weightMin}
                onChange={(e) => setWeightMin(e.target.value)}
              />
            </Filter>
            <Filter label="计费重 ≤ (kg)">
              <Input
                type="number"
                step="0.1"
                value={weightMax}
                onChange={(e) => setWeightMax(e.target.value)}
              />
            </Filter>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
            <span>{loading ? '加载中…' : `命中 ${items.length} 票`}</span>
            <Button
              onClick={() => {
                setQ('');
                setCountry('');
                setCarrier('');
                setWeightMin('');
                setWeightMax('');
              }}
            >
              清空筛选
            </Button>
          </div>
        </Card>

        <Card className="mt-4 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="p-3">日期</th>
                  <th className="p-3">国家</th>
                  <th className="p-3">商品</th>
                  <th className="p-3">线路</th>
                  <th className="p-3 text-right">实重 kg</th>
                  <th className="p-3 text-right">材积 kg</th>
                  <th className="p-3 text-right">计费 kg</th>
                  <th className="p-3 text-right">¥/kg</th>
                  <th className="p-3 text-right">运费</th>
                  <th className="p-3 text-right">杂费</th>
                  <th className="p-3 text-right">总额</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className="border-t border-zinc-100">
                    <td className="p-3 text-zinc-500">{s.date}</td>
                    <td className="p-3">
                      <Badge tone="muted">{s.country || '—'}</Badge>
                    </td>
                    <td className="p-3 max-w-[200px] truncate" title={s.itemDescription}>
                      {s.itemDescription}
                    </td>
                    <td className="p-3 text-xs text-zinc-600">{s.service}</td>
                    <td className="p-3 text-right tabular-nums">{s.actualWeightKg ?? '—'}</td>
                    <td className="p-3 text-right tabular-nums text-zinc-500">
                      {s.volumetricWeightKg ?? '—'}
                    </td>
                    <td className="p-3 text-right font-medium tabular-nums">
                      {s.chargeableWeightKg ?? '—'}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {s.pricePerKg != null ? `¥${s.pricePerKg.toFixed(2)}` : '—'}
                    </td>
                    <td className="p-3 text-right tabular-nums">{s.freightFee ?? '—'}</td>
                    <td className="p-3 text-right tabular-nums text-zinc-500">
                      {s.miscFee ?? '—'}
                    </td>
                    <td className="p-3 text-right font-semibold tabular-nums">
                      {s.totalAmount != null ? `¥${s.totalAmount.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-sm text-zinc-400">
                      没有命中的票据。试试清空筛选 / 运行{' '}
                      <code className="rounded bg-zinc-100 px-1.5 py-0.5">
                        node scripts/import-shipments.js &lt;xls 路径&gt;
                      </code>{' '}
                      导入数据。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </main>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      {children}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function MiniTable({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3">
      <div className="mb-2 text-xs font-semibold text-zinc-600">{title}</div>
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-zinc-100 first:border-t-0">
              <td className="py-1.5 text-zinc-700">{k}</td>
              <td className="py-1.5 text-right text-zinc-500">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
