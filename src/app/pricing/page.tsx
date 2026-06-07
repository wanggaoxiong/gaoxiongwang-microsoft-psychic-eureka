'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  calculatePrice,
  defaultPricingStrategy,
  type Carrier,
  type CarrierService,
  type PackagingOption,
  type PriceResult,
  type PricingStrategy,
  type QualityGrade
} from '@/lib/pricing/engine';
import { Badge, Button, Card, Divider, Input, Label, Select } from '@/lib/ui/primitives';

type Section = 'base' | 'quality' | 'packaging' | 'carriers' | 'tiers' | 'region' | 'try';

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: 'base', label: '基础', hint: '币种 / 关税 / 汇率缓冲 / 默认利润 / 护栏' },
  { id: 'quality', label: '质量分级', hint: 'A / AAA / OEM …，作用于商品成本倍数' },
  { id: 'packaging', label: '包装方案', hint: '不同包装的成本 / 重量 / 体积' },
  { id: 'carriers', label: '物流承运商', hint: '增删快递公司与服务等级，按 kg + 体积重计费' },
  { id: 'tiers', label: '阶梯利润', hint: '按购买数量调整利润率' },
  { id: 'region', label: '地区 / 客户分层', hint: '不同国家或客户类型的利润微调' },
  { id: 'try', label: '试算', hint: '输入商品成本 / 重量 / 体积，立刻看 breakdown' }
];

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function PricingPage() {
  const [strategy, setStrategy] = useState<PricingStrategy>(defaultPricingStrategy);
  const [active, setActive] = useState<Section>('base');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/pricing/strategy', { cache: 'no-store' });
        const j = await r.json();
        if (alive && j.ok) setStrategy(j.strategy);
      } catch {
        /* keep default */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function patch(p: Partial<PricingStrategy>) {
    setStrategy((prev) => ({ ...prev, ...p }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setToast(null);
    try {
      const r = await fetch('/api/pricing/strategy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(strategy)
      });
      const j = await r.json();
      if (j.ok) {
        setStrategy(j.strategy);
        setDirty(false);
        setToast('已保存');
      } else {
        setToast(`保存失败：${j.error ?? '校验未通过'}`);
      }
    } catch (e: any) {
      setToast(`保存异常：${e?.message ?? e}`);
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 3000);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-end justify-between gap-4 px-8 py-6">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">报价策略</h1>
            <p className="mt-1 text-sm text-zinc-500">
              报价 = 商品成本 × 质量系数 + 包装 + 物流（按计费重量）+ 关税 / 汇率缓冲 + 利润加成。
              AI 会在与客户沟通时按客户所选条件实时算价。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty ? <Badge tone="warning">未保存</Badge> : <Badge tone="muted">已同步</Badge>}
            <Button variant="primary" onClick={save} disabled={saving || loading}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-6 pb-3">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition ${
                active === s.id
                  ? 'bg-[#5E6AD2] text-white'
                  : 'text-zinc-600 hover:bg-zinc-100'
              }`}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-8 py-6">
        {loading ? (
          <p className="text-sm text-zinc-400">加载中…</p>
        ) : (
          <>
            {active === 'base' && <BaseEditor strategy={strategy} patch={patch} />}
            {active === 'quality' && (
              <QualityEditor
                items={strategy.qualityGrades}
                onChange={(qualityGrades) => patch({ qualityGrades })}
              />
            )}
            {active === 'packaging' && (
              <PackagingEditor
                items={strategy.packagingOptions}
                onChange={(packagingOptions) => patch({ packagingOptions })}
              />
            )}
            {active === 'carriers' && (
              <CarriersEditor
                items={strategy.carriers}
                onChange={(carriers) => patch({ carriers })}
              />
            )}
            {active === 'tiers' && <TiersEditor strategy={strategy} patch={patch} />}
            {active === 'region' && <RegionSegmentEditor strategy={strategy} patch={patch} />}
            {active === 'try' && <TryItOut strategy={strategy} />}
          </>
        )}
      </div>

      {toast ? (
        <div className="fixed bottom-6 right-6 rounded-md bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </main>
  );
}

/* ───────── Base ───────── */

function BaseEditor({
  strategy,
  patch
}: {
  strategy: PricingStrategy;
  patch: (p: Partial<PricingStrategy>) => void;
}) {
  const f = strategy.baseFormula;
  const g = strategy.guardrails;
  return (
    <Card className="p-6">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="策略名">
          <Input value={strategy.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label="币种 (ISO)">
          <Input
            value={strategy.currency}
            onChange={(e) => patch({ currency: e.target.value.toUpperCase().slice(0, 3) })}
          />
        </Field>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-zinc-700">基础公式</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="供货价系数" hint="供货价乘以此倍数">
          <NumberInput
            value={f.supplierCostFactor}
            step={0.05}
            onChange={(v) => patch({ baseFormula: { ...f, supplierCostFactor: v } })}
          />
        </Field>
        <Field label="关税 %" hint="比如 0.05 = 5%">
          <NumberInput
            value={f.dutyPct}
            step={0.01}
            onChange={(v) => patch({ baseFormula: { ...f, dutyPct: v } })}
          />
        </Field>
        <Field label="汇率缓冲 %">
          <NumberInput
            value={f.fxBufferPct}
            step={0.01}
            onChange={(v) => patch({ baseFormula: { ...f, fxBufferPct: v } })}
          />
        </Field>
        <Field label="默认利润率" hint="无阶梯命中时的兜底">
          <NumberInput
            value={f.marginPct}
            step={0.01}
            onChange={(v) => patch({ baseFormula: { ...f, marginPct: v } })}
          />
        </Field>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-zinc-700">护栏</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="最小利润率 %" hint="0-95">
          <NumberInput
            value={g.minMarginPct}
            step={1}
            onChange={(v) => patch({ guardrails: { ...g, minMarginPct: v } })}
          />
        </Field>
        <Field label="最低单价">
          <NumberInput
            value={g.minUnitPrice}
            step={0.1}
            onChange={(v) => patch({ guardrails: { ...g, minUnitPrice: v } })}
          />
        </Field>
        <Field label="谈判最大让步 %">
          <NumberInput
            value={g.maxDiscountPct}
            step={1}
            onChange={(v) => patch({ guardrails: { ...g, maxDiscountPct: v } })}
          />
        </Field>
      </div>
    </Card>
  );
}

/* ───────── Quality ───────── */

function QualityEditor({
  items,
  onChange
}: {
  items: QualityGrade[];
  onChange: (next: QualityGrade[]) => void;
}) {
  function update(i: number, p: Partial<QualityGrade>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...p } : it)));
  }
  return (
    <Card className="p-6">
      <Header
        title="质量分级"
        desc="同一款商品按品质给不同倍数，AI 会根据客户对品质的要求自动选择。"
        action={
          <Button
            onClick={() =>
              onChange([...items, { code: 'NEW', name: '新分级', costMultiplier: 1 }])
            }
          >
            + 新增分级
          </Button>
        }
      />
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-zinc-400">还没有分级</p>
        ) : (
          items.map((it, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-3 rounded-md border border-zinc-200 p-3 sm:grid-cols-[120px_1fr_140px_1fr_auto]"
            >
              <Field label="Code">
                <Input value={it.code} onChange={(e) => update(i, { code: e.target.value })} />
              </Field>
              <Field label="名称">
                <Input value={it.name} onChange={(e) => update(i, { name: e.target.value })} />
              </Field>
              <Field label="成本倍数">
                <NumberInput
                  value={it.costMultiplier}
                  step={0.05}
                  onChange={(v) => update(i, { costMultiplier: v })}
                />
              </Field>
              <Field label="备注">
                <Input
                  value={it.notes ?? ''}
                  onChange={(e) => update(i, { notes: e.target.value })}
                />
              </Field>
              <RemoveBtn onClick={() => onChange(items.filter((_, idx) => idx !== i))} />
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/* ───────── Packaging ───────── */

function PackagingEditor({
  items,
  onChange
}: {
  items: PackagingOption[];
  onChange: (next: PackagingOption[]) => void;
}) {
  function update(i: number, p: Partial<PackagingOption>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...p } : it)));
  }
  return (
    <Card className="p-6">
      <Header
        title="包装方案"
        desc="不同包装会增加重量 / 体积，进而影响物流计费。"
        action={
          <Button
            onClick={() =>
              onChange([
                ...items,
                { id: uid('pkg'), name: '新包装', cost: 0, addWeightGrams: 0, addVolumeCm3: 0 }
              ])
            }
          >
            + 新增包装
          </Button>
        }
      />
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-zinc-400">还没有包装方案</p>
        ) : (
          items.map((it, i) => (
            <div
              key={it.id}
              className="grid grid-cols-1 gap-3 rounded-md border border-zinc-200 p-3 sm:grid-cols-[1fr_140px_140px_140px_auto]"
            >
              <Field label="名称">
                <Input value={it.name} onChange={(e) => update(i, { name: e.target.value })} />
              </Field>
              <Field label="成本">
                <NumberInput value={it.cost} step={0.1} onChange={(v) => update(i, { cost: v })} />
              </Field>
              <Field label="+ 重量 (g)">
                <NumberInput
                  value={it.addWeightGrams}
                  step={10}
                  onChange={(v) => update(i, { addWeightGrams: v })}
                />
              </Field>
              <Field label="+ 体积 (cm³)">
                <NumberInput
                  value={it.addVolumeCm3}
                  step={100}
                  onChange={(v) => update(i, { addVolumeCm3: v })}
                />
              </Field>
              <RemoveBtn onClick={() => onChange(items.filter((_, idx) => idx !== i))} />
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/* ───────── Carriers ───────── */

function CarriersEditor({
  items,
  onChange
}: {
  items: Carrier[];
  onChange: (next: Carrier[]) => void;
}) {
  function updateCarrier(i: number, p: Partial<Carrier>) {
    onChange(items.map((c, idx) => (idx === i ? { ...c, ...p } : c)));
  }
  function addService(i: number) {
    const c = items[i];
    const svc: CarrierService = {
      id: uid('svc'),
      name: '新服务',
      speedDays: '',
      regions: [],
      pricePerKg: 0,
      baseFee: 0,
      volumetricDivisor: 5000,
      minChargeKg: 0
    };
    updateCarrier(i, { services: [...c.services, svc] });
  }
  function updateService(i: number, sIdx: number, p: Partial<CarrierService>) {
    const c = items[i];
    updateCarrier(i, {
      services: c.services.map((s, idx) => (idx === sIdx ? { ...s, ...p } : s))
    });
  }
  function removeService(i: number, sIdx: number) {
    const c = items[i];
    updateCarrier(i, { services: c.services.filter((_, idx) => idx !== sIdx) });
  }

  return (
    <Card className="p-6">
      <Header
        title="物流承运商"
        desc="计费重量 = max(实重, 体积 ÷ 体积重除数, 最低计费重)。地区留空表示全球。"
        action={
          <Button
            onClick={() =>
              onChange([...items, { id: uid('car'), name: '新承运商', services: [] }])
            }
          >
            + 新增承运商
          </Button>
        }
      />
      <div className="mt-4 space-y-4">
        {items.length === 0 ? (
          <p className="text-sm text-zinc-400">还没有承运商</p>
        ) : (
          items.map((c, i) => (
            <div key={c.id} className="rounded-md border border-zinc-200">
              <div className="flex items-end gap-3 border-b border-zinc-100 p-3">
                <Field label="Code">
                  <Input
                    value={c.id}
                    onChange={(e) => updateCarrier(i, { id: e.target.value })}
                  />
                </Field>
                <Field label="承运商名称" className="flex-1">
                  <Input value={c.name} onChange={(e) => updateCarrier(i, { name: e.target.value })} />
                </Field>
                <Button onClick={() => addService(i)}>+ 新增服务</Button>
                <RemoveBtn
                  onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                  label="删除承运商"
                />
              </div>
              <div className="space-y-3 p-3">
                {c.services.length === 0 ? (
                  <p className="text-xs text-zinc-400">该承运商还没有服务等级</p>
                ) : (
                  c.services.map((s, sIdx) => (
                    <div
                      key={s.id}
                      className="grid grid-cols-1 gap-2 rounded-md bg-zinc-50 p-3 lg:grid-cols-[1fr_1fr_100px_100px_100px_100px_140px_auto]"
                    >
                      <Field label="服务名">
                        <Input
                          value={s.name}
                          onChange={(e) => updateService(i, sIdx, { name: e.target.value })}
                        />
                      </Field>
                      <Field label="时效">
                        <Input
                          value={s.speedDays}
                          onChange={(e) => updateService(i, sIdx, { speedDays: e.target.value })}
                        />
                      </Field>
                      <Field label="基础费">
                        <NumberInput
                          value={s.baseFee}
                          step={1}
                          onChange={(v) => updateService(i, sIdx, { baseFee: v })}
                        />
                      </Field>
                      <Field label="每 kg">
                        <NumberInput
                          value={s.pricePerKg}
                          step={0.5}
                          onChange={(v) => updateService(i, sIdx, { pricePerKg: v })}
                        />
                      </Field>
                      <Field label="体积除数">
                        <NumberInput
                          value={s.volumetricDivisor}
                          step={500}
                          onChange={(v) => updateService(i, sIdx, { volumetricDivisor: v })}
                        />
                      </Field>
                      <Field label="最低 kg">
                        <NumberInput
                          value={s.minChargeKg ?? 0}
                          step={0.1}
                          onChange={(v) => updateService(i, sIdx, { minChargeKg: v })}
                        />
                      </Field>
                      <Field label="地区 (逗号)" hint="空 = 全球">
                        <Input
                          value={(s.regions ?? []).join(',')}
                          onChange={(e) =>
                            updateService(i, sIdx, {
                              regions: e.target.value
                                .split(',')
                                .map((x) => x.trim().toUpperCase())
                                .filter(Boolean)
                            })
                          }
                        />
                      </Field>
                      <RemoveBtn onClick={() => removeService(i, sIdx)} />
                    </div>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/* ───────── Tiers ───────── */

function TiersEditor({
  strategy,
  patch
}: {
  strategy: PricingStrategy;
  patch: (p: Partial<PricingStrategy>) => void;
}) {
  const tiers = strategy.tiers;
  function update(i: number, p: Partial<(typeof tiers)[number]>) {
    patch({ tiers: tiers.map((t, idx) => (idx === i ? { ...t, ...p } : t)) });
  }
  return (
    <Card className="p-6">
      <Header
        title="阶梯利润"
        desc="数量大于等于 minQty 时，使用对应的利润率。例如 1 件 / 50 件 / 200 件分别给不同利润。"
        action={
          <Button
            onClick={() => patch({ tiers: [...tiers, { minQty: 1, marginPct: 0.3 }] })}
          >
            + 新增阶梯
          </Button>
        }
      />
      <div className="mt-4 space-y-2">
        {tiers.map((t, i) => (
          <div
            key={i}
            className="grid grid-cols-[140px_140px_auto] gap-3 rounded-md border border-zinc-200 p-3"
          >
            <Field label="最低数量 (件)">
              <NumberInput
                value={t.minQty}
                step={1}
                onChange={(v) => update(i, { minQty: Math.max(1, Math.round(v)) })}
              />
            </Field>
            <Field label="利润率 0-0.95">
              <NumberInput
                value={t.marginPct}
                step={0.01}
                onChange={(v) => update(i, { marginPct: v })}
              />
            </Field>
            <RemoveBtn onClick={() => patch({ tiers: tiers.filter((_, idx) => idx !== i) })} />
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ───────── Region / Segment ───────── */

function RegionSegmentEditor({
  strategy,
  patch
}: {
  strategy: PricingStrategy;
  patch: (p: Partial<PricingStrategy>) => void;
}) {
  const regionRows = Object.entries(strategy.regionAdjust);
  const segRows = Object.entries(strategy.customerSegmentAdjust);

  function patchRegion(next: Record<string, { marginPctDelta: number; minMarginPct?: number }>) {
    patch({ regionAdjust: next });
  }
  function patchSeg(next: Record<string, { marginPctDelta: number }>) {
    patch({ customerSegmentAdjust: next });
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <Header
          title="按地区调整"
          desc="不同国家可加 / 减利润率（绝对值，单位 1 = 100%）。可单独设最小利润护栏。"
          action={
            <Button
              onClick={() =>
                patchRegion({ ...strategy.regionAdjust, NEW: { marginPctDelta: 0 } })
              }
            >
              + 新增地区
            </Button>
          }
        />
        <div className="mt-4 space-y-2">
          {regionRows.length === 0 ? (
            <p className="text-sm text-zinc-400">还没有地区规则</p>
          ) : (
            regionRows.map(([code, rule]) => (
              <div
                key={code}
                className="grid grid-cols-[120px_140px_140px_auto] gap-3 rounded-md border border-zinc-200 p-3"
              >
                <Field label="国家码">
                  <Input
                    value={code}
                    onChange={(e) => {
                      const newCode = e.target.value.toUpperCase();
                      const next = { ...strategy.regionAdjust };
                      delete next[code];
                      next[newCode] = rule;
                      patchRegion(next);
                    }}
                  />
                </Field>
                <Field label="Δ 利润率">
                  <NumberInput
                    value={rule.marginPctDelta}
                    step={0.01}
                    onChange={(v) =>
                      patchRegion({ ...strategy.regionAdjust, [code]: { ...rule, marginPctDelta: v } })
                    }
                  />
                </Field>
                <Field label="最小利润 %（可空）">
                  <NumberInput
                    value={rule.minMarginPct ?? 0}
                    step={1}
                    onChange={(v) =>
                      patchRegion({
                        ...strategy.regionAdjust,
                        [code]: { ...rule, minMarginPct: v || undefined }
                      })
                    }
                  />
                </Field>
                <RemoveBtn
                  onClick={() => {
                    const next = { ...strategy.regionAdjust };
                    delete next[code];
                    patchRegion(next);
                  }}
                />
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="p-6">
        <Header
          title="按客户分层调整"
          desc="例如 NEW / VIP / WHOLESALE，AI 会根据客户标签匹配。"
          action={
            <Button
              onClick={() =>
                patchSeg({ ...strategy.customerSegmentAdjust, NEW: { marginPctDelta: 0 } })
              }
            >
              + 新增分层
            </Button>
          }
        />
        <div className="mt-4 space-y-2">
          {segRows.length === 0 ? (
            <p className="text-sm text-zinc-400">还没有客户分层规则</p>
          ) : (
            segRows.map(([code, rule]) => (
              <div
                key={code}
                className="grid grid-cols-[160px_160px_auto] gap-3 rounded-md border border-zinc-200 p-3"
              >
                <Field label="分层代码">
                  <Input
                    value={code}
                    onChange={(e) => {
                      const newCode = e.target.value.toUpperCase();
                      const next = { ...strategy.customerSegmentAdjust };
                      delete next[code];
                      next[newCode] = rule;
                      patchSeg(next);
                    }}
                  />
                </Field>
                <Field label="Δ 利润率">
                  <NumberInput
                    value={rule.marginPctDelta}
                    step={0.01}
                    onChange={(v) =>
                      patchSeg({
                        ...strategy.customerSegmentAdjust,
                        [code]: { marginPctDelta: v }
                      })
                    }
                  />
                </Field>
                <RemoveBtn
                  onClick={() => {
                    const next = { ...strategy.customerSegmentAdjust };
                    delete next[code];
                    patchSeg(next);
                  }}
                />
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}

/* ───────── Try (live calc) ───────── */

function TryItOut({ strategy }: { strategy: PricingStrategy }) {
  const [form, setForm] = useState({
    supplierCost: 68,
    weightGrams: 620,
    volumeCm3: 4000,
    qty: 50,
    region: '',
    customerSegment: '',
    qualityCode: '',
    packagingId: '',
    carrierServiceId: '',
    negotiationRound: 0
  });

  const carrierOptions = useMemo(() => {
    const opts: { id: string; label: string }[] = [];
    for (const c of strategy.carriers) {
      for (const s of c.services) {
        opts.push({ id: `${c.id}:${s.id}`, label: `${c.name} · ${s.name}` });
      }
    }
    return opts;
  }, [strategy.carriers]);

  const result: PriceResult | null = useMemo(() => {
    try {
      return calculatePrice(strategy, {
        ...form,
        region: form.region || undefined,
        customerSegment: form.customerSegment || undefined,
        qualityCode: form.qualityCode || undefined,
        packagingId: form.packagingId || undefined,
        carrierServiceId: form.carrierServiceId || undefined
      });
    } catch {
      return null;
    }
  }, [form, strategy]);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[420px_1fr]">
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-zinc-700">输入</h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="供货价">
            <NumberInput value={form.supplierCost} step={1} onChange={(v) => set('supplierCost', v)} />
          </Field>
          <Field label="数量">
            <NumberInput
              value={form.qty}
              step={1}
              onChange={(v) => set('qty', Math.max(1, Math.round(v)))}
            />
          </Field>
          <Field label="实重 (g)">
            <NumberInput value={form.weightGrams} step={10} onChange={(v) => set('weightGrams', v)} />
          </Field>
          <Field label="体积 (cm³)">
            <NumberInput value={form.volumeCm3} step={100} onChange={(v) => set('volumeCm3', v)} />
          </Field>
          <Field label="地区">
            <Select value={form.region} onChange={(e) => set('region', e.target.value)}>
              <option value="">(无)</option>
              {Object.keys(strategy.regionAdjust).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="客户分层">
            <Select
              value={form.customerSegment}
              onChange={(e) => set('customerSegment', e.target.value)}
            >
              <option value="">(无)</option>
              {Object.keys(strategy.customerSegmentAdjust).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="质量">
            <Select value={form.qualityCode} onChange={(e) => set('qualityCode', e.target.value)}>
              <option value="">(无)</option>
              {strategy.qualityGrades.map((q) => (
                <option key={q.code} value={q.code}>
                  {q.name} (×{q.costMultiplier})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="包装">
            <Select value={form.packagingId} onChange={(e) => set('packagingId', e.target.value)}>
              <option value="">(无)</option>
              {strategy.packagingOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="物流" className="col-span-2">
            <Select
              value={form.carrierServiceId}
              onChange={(e) => set('carrierServiceId', e.target.value)}
            >
              <option value="">(无)</option>
              {carrierOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="谈判轮次">
            <NumberInput
              value={form.negotiationRound}
              step={1}
              onChange={(v) => set('negotiationRound', Math.max(0, Math.round(v)))}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-zinc-700">报价 Breakdown</h3>
        {!result ? (
          <p className="mt-3 text-sm text-rose-500">参数无效</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-semibold text-zinc-900">
                {result.unitPrice} {result.currency}
              </span>
              <span className="text-sm text-zinc-500">/ 件</span>
              <Badge tone="accent">毛利 {(result.marginPct * 100).toFixed(1)}%</Badge>
            </div>
            <div className="text-sm text-zinc-600">
              {form.qty} 件合计 ≈{' '}
              <span className="font-semibold text-zinc-900">
                {result.total} {result.currency}
              </span>
              {result.resolved.chargeableWeightKg !== undefined ? (
                <>
                  {' · '}计费重量 {result.resolved.chargeableWeightKg} kg
                </>
              ) : null}
            </div>
            <Divider />
            <table className="w-full text-sm">
              <tbody>
                <Row label="商品成本" value={result.breakdown.product} currency={result.currency} />
                <Row label="包装" value={result.breakdown.packaging} currency={result.currency} />
                <Row label="物流" value={result.breakdown.logistics} currency={result.currency} />
                <Row label="关税" value={result.breakdown.duty} currency={result.currency} />
                <Row label="汇率缓冲" value={result.breakdown.fxBuffer} currency={result.currency} />
                <tr className="border-t">
                  <td className="py-1.5 font-medium text-zinc-700">总成本</td>
                  <td className="py-1.5 text-right font-medium text-zinc-700">
                    {result.breakdown.totalCost} {result.currency}
                  </td>
                </tr>
                <Row label="利润" value={result.breakdown.margin} currency={result.currency} highlight />
              </tbody>
            </table>
            <div className="flex flex-wrap gap-1.5">
              {result.hitRules.map((r) => (
                <Badge key={r} tone="muted">
                  {r}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  currency,
  highlight
}: {
  label: string;
  value: number;
  currency: string;
  highlight?: boolean;
}) {
  return (
    <tr>
      <td className={`py-1.5 ${highlight ? 'font-semibold text-emerald-700' : 'text-zinc-500'}`}>
        {label}
      </td>
      <td
        className={`py-1.5 text-right ${highlight ? 'font-semibold text-emerald-700' : 'text-zinc-700'}`}
      >
        {value} {currency}
      </td>
    </tr>
  );
}

/* ───────── small UI helpers ───────── */

function Field({
  label,
  hint,
  children,
  className = ''
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <Label title={hint}>{label}</Label>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  step
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <Input
      type="number"
      step={step ?? 'any'}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? n : 0);
      }}
    />
  );
}

function RemoveBtn({ onClick, label = '删除' }: { onClick: () => void; label?: string }) {
  return (
    <div className="flex items-end">
      <Button onClick={onClick} className="border-rose-200 text-rose-600 hover:bg-rose-50">
        {label}
      </Button>
    </div>
  );
}

function Header({
  title,
  desc,
  action
}: {
  title: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
        {desc ? <p className="mt-1 text-xs text-zinc-500">{desc}</p> : null}
      </div>
      {action}
    </div>
  );
}
