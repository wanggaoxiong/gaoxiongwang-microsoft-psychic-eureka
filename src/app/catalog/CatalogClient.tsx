'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Input, Select, Badge, Empty, Divider } from '@/lib/ui/primitives';
import { ProductDrawer } from './ProductDrawer';
import { AddProductModal } from './AddProductModal';
import type { CatalogProduct } from '@/lib/catalog/repo';
import { loadAiConfig, isAiConfigured, getEffectiveSearchModel } from '@/lib/ai/config';

type ListResponse = {
  items: CatalogProduct[];
  total: number;
  brands: Array<{ name: string; count: number }>;
  sources: Array<{ name: string; count: number }>;
  duplicates?: Record<string, string[]>;
};

export function CatalogClient() {
  const search = useSearchParams();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState('');
  const [sort, setSort] = useState<'newest' | 'price-asc' | 'price-desc'>('newest');
  const [selected, setSelected] = useState<CatalogProduct | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  // 分页
  const [pageSize, setPageSize] = useState<number | 'all'>(24);
  const [pageIndex, setPageIndex] = useState(0);
  // AI 检索
  const [aiQuery, setAiQuery] = useState('');
  const [aiSearching, setAiSearching] = useState(false);
  const [aiResult, setAiResult] = useState<{
    ids: string[];
    reasoning: string;
    query: string;
    elapsedMs?: number;
    modelEcho?: string;
  } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  async function fetchList(opts?: { q?: string; brand?: string; sort?: string }) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const qv = opts?.q ?? q;
      const bv = opts?.brand ?? brand;
      const sv = opts?.sort ?? sort;
      if (qv) params.set('q', qv);
      if (bv) params.set('brand', bv);
      if (sv) params.set('sort', sv);
      const res = await fetch('/api/catalog?' + params.toString());
      const json = await res.json();
      setData(json);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 深链 ?focus=id 自动打开抽屉
  useEffect(() => {
    const focus = search?.get('focus');
    if (!focus || !data) return;
    const found = data.items.find((p) => p.id === focus);
    if (found) setSelected(found);
  }, [search, data]);

  useEffect(() => {
    const t = setTimeout(() => fetchList(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, brand, sort]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const brands = data?.brands ?? [];
  const duplicates = data?.duplicates ?? {};
  // 以 product.id 为键，映射到重复组的总数（表明 “同品牌+型号 ×N件”）
  const dupCountById = useMemo(() => {
    const m = new Map<string, number>();
    for (const ids of Object.values(duplicates)) {
      for (const id of ids) m.set(id, ids.length);
    }
    return m;
  }, [duplicates]);

  function toggleChecked(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    if (checked.size === 0) return;
    if (!confirm(`确认删除 ${checked.size} 个商品？`)) return;
    await fetch('/api/catalog', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(checked) })
    });
    setChecked(new Set());
    fetchList();
  }

  async function runAiSearch() {
    const query = aiQuery.trim();
    if (!query) return;
    const cfg = loadAiConfig();
    if (!isAiConfigured(cfg)) {
      setAiError('请先在「设置 → AI 模型」填写 Azure Endpoint / API Key');
      return;
    }
    setAiSearching(true);
    setAiError(null);
    try {
      const r = await fetch('/api/catalog/ai-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          azure: {
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            model: getEffectiveSearchModel(cfg)
          }
        })
      });
      const j = await r.json();
      if (!r.ok) {
        setAiError(j?.error ?? `HTTP ${r.status}`);
      } else {
        setAiResult({
          ids: j.ids ?? [],
          reasoning: j.reasoning ?? '',
          query,
          elapsedMs: j.elapsedMs,
          modelEcho: j.modelEcho
        });
        setPageIndex(0);
      }
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiSearching(false);
    }
  }

  function clearAiSearch() {
    setAiQuery('');
    setAiResult(null);
    setAiError(null);
  }

  const empty = !loading && items.length === 0;

  // AI 检索结果：按返回顺序展示
  const orderedItems = useMemo(() => {
    if (!aiResult) return items;
    const map = new Map(items.map((p) => [p.id, p] as const));
    return aiResult.ids.map((id) => map.get(id)).filter((p): p is CatalogProduct => !!p);
  }, [items, aiResult]);

  // 分页切片
  const effectivePageSize = pageSize === 'all' ? orderedItems.length || 1 : pageSize;
  const pageCount =
    pageSize === 'all' ? 1 : Math.max(1, Math.ceil(orderedItems.length / effectivePageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleItems =
    pageSize === 'all'
      ? orderedItems
      : orderedItems.slice(safePageIndex * effectivePageSize, (safePageIndex + 1) * effectivePageSize);

  return (
    <div className="min-h-screen">
      {/* header */}
      <div className="sticky top-0 z-40 border-b border-zinc-200 bg-white/95 px-8 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-zinc-950">Catalog</h1>
            <p className="text-xs text-zinc-500">
              {loading ? '加载中…' : `${total} 件商品`}
              {brands.length > 0 ? ` · ${brands.length} 个品牌` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/sources">
              <Button variant="ghost" size="md">
                Sources
              </Button>
            </Link>
            <Button
              variant="primary"
              leading={<span>+</span>}
              onClick={() => setShowAdd(true)}
            >
              添加商品
            </Button>
          </div>
        </div>

        {/* filter bar */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索 标题 / 品牌 / 型号 / 商家"
              className="pl-7"
            />
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-zinc-400">
              ⌕
            </span>
          </div>
          <Select value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">全部品牌</option>
            {brands.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} ({b.count})
              </option>
            ))}
          </Select>
          <Select
            value={sort}
            onChange={(e) =>
              setSort(e.target.value as 'newest' | 'price-asc' | 'price-desc')
            }
          >
            <option value="newest">最新添加</option>
            <option value="price-asc">价格升序</option>
            <option value="price-desc">价格降序</option>
          </Select>
          {checked.size > 0 ? (
            <>
              <Divider className="mx-1 h-5 w-px" />
              <span className="text-xs text-zinc-500">已选 {checked.size}</span>
              <Button variant="danger" size="sm" onClick={deleteSelected}>
                删除
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}>
                取消
              </Button>
            </>
          ) : null}
        </div>

        {/* AI 检索 — 自然语言描述需求，由模型挑选匹配的商品 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[280px] max-w-2xl flex-1">
            <Input
              value={aiQuery}
              onChange={(e) => setAiQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !aiSearching) runAiSearch();
              }}
              placeholder="AI 检索：用自然语言描述，例如「黑色男士乐福鞋」「1000 元内女士腕包」「LV 本周上架」"
              className="pl-7"
              disabled={aiSearching}
            />
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[#5E6AD2]">
              ✦
            </span>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={runAiSearch}
            disabled={!aiQuery.trim() || aiSearching}
          >
            {aiSearching ? 'AI 检索中…' : 'AI 检索'}
          </Button>
          {aiResult || aiError ? (
            <Button variant="ghost" size="md" onClick={clearAiSearch}>
              清除
            </Button>
          ) : null}
        </div>
        {aiError ? (
          <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{aiError}</div>
        ) : null}
        {aiResult ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[#5E6AD2]/40 bg-[#5E6AD2]/5 px-3 py-2 text-xs">
            <Badge tone="accent">AI</Badge>
            <span className="text-zinc-700">
              「{aiResult.query}」— 命中 <strong>{aiResult.ids.length}</strong> 件
            </span>
            {aiResult.reasoning ? (
              <span className="text-zinc-500">· {aiResult.reasoning}</span>
            ) : null}
            {aiResult.elapsedMs ? (
              <span className="ml-auto text-[11px] text-zinc-400">
                {aiResult.modelEcho} · {aiResult.elapsedMs}ms
              </span>
            ) : null}
          </div>
        ) : null}

        {/* 分页控件 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>每页显示</span>
          {[12, 24, 36, 48].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => {
                setPageSize(n);
                setPageIndex(0);
              }}
              className={`rounded px-2 py-1 ${
                pageSize === n
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              }`}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPageSize('all');
              setPageIndex(0);
            }}
            className={`rounded px-2 py-1 ${
              pageSize === 'all'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            }`}
          >
            全部
          </button>
          {pageSize !== 'all' && pageCount > 1 ? (
            <div className="ml-2 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPageIndex(Math.max(0, safePageIndex - 1))}
                disabled={safePageIndex === 0}
                className="rounded bg-zinc-100 px-2 py-1 text-zinc-600 hover:bg-zinc-200 disabled:opacity-40"
              >
                ←
              </button>
              <span className="px-1 text-zinc-500">
                {safePageIndex + 1} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPageIndex(Math.min(pageCount - 1, safePageIndex + 1))}
                disabled={safePageIndex >= pageCount - 1}
                className="rounded bg-zinc-100 px-2 py-1 text-zinc-600 hover:bg-zinc-200 disabled:opacity-40"
              >
                →
              </button>
            </div>
          ) : null}
          <span className="ml-auto text-[11px] text-zinc-400">
            共 {orderedItems.length} 件{aiResult ? `（全量 ${items.length}）` : ''}
          </span>
        </div>
      </div>

      {/* content */}
      <div className="px-8 py-6">
        {empty ? (
          <Empty
            title="Catalog 还是空的"
            description="点右上角 “+ 添加商品” 从详情页 URL 拓取，或去 Sources 从发现池里挑选"
            action={
              <Button variant="primary" onClick={() => setShowAdd(true)}>
                + 添加首个商品
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {visibleItems.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                checked={checked.has(p.id)}
                duplicateCount={dupCountById.get(p.id) ?? 0}
                onCheck={() => toggleChecked(p.id)}
                onClick={() => setSelected(p)}
              />
            ))}
          </div>
        )}
      </div>

      <ProductDrawer
        product={selected}
        onClose={() => setSelected(null)}
        onDelete={() => {
          setSelected(null);
          fetchList();
        }}
      />
      <AddProductModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          setShowAdd(false);
          fetchList();
        }}
      />
    </div>
  );
}

function ProductCard({
  product,
  checked,
  duplicateCount,
  onCheck,
  onClick
}: {
  product: CatalogProduct;
  checked: boolean;
  duplicateCount: number;
  onCheck: () => void;
  onClick: () => void;
}) {
  const showDup = duplicateCount > 1;
  return (
    <div
      onClick={onClick}
      className={`group relative z-0 cursor-pointer overflow-hidden rounded-lg border bg-white transition-shadow hover:shadow-md ${
        checked ? 'border-[#5E6AD2] ring-2 ring-[#5E6AD2]/30' : 'border-zinc-200'
      }`}
    >
      {/* checkbox：选中状态强制始终可见，未选中时仅 hover 显示 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCheck();
        }}
        aria-label={checked ? '取消选中' : '选中'}
        className={`absolute left-2 top-2 z-[1] flex h-5 w-5 items-center justify-center rounded border shadow-sm transition-opacity ${
          checked
            ? 'border-[#5E6AD2] bg-[#5E6AD2] opacity-100'
            : 'border-zinc-300 bg-white opacity-0 group-hover:opacity-100'
        }`}
      >
        {checked ? (
          <svg
            viewBox="0 0 12 12"
            className="h-3 w-3"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="2.5 6.5 5 9 9.5 3.5" />
          </svg>
        ) : null}
      </button>
      <div className="relative aspect-square overflow-hidden bg-zinc-100">
        {product.mainImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.mainImage}
            alt={product.title}
            className="h-full w-full object-cover transition group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-400">无图</div>
        )}
        {showDup ? (
          <span
            title={`同款 / 相似款共 ${duplicateCount} 件，共用相同 “${product.brand} ${product.model}”（可能是同款不同颜色/不同 sourceCode，或被 LLM 误判为同型号）`}
            className="absolute right-2 top-2 z-[1] inline-flex items-center gap-1 rounded-full bg-amber-500/95 py-0.5 pl-1.5 pr-2 text-[10px] font-semibold text-white shadow"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden="true">
              <path
                d="M8 2.5 13.5 5 8 7.5 2.5 5 8 2.5Z"
                fill="currentColor"
                fillOpacity="0.35"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
              <path
                d="M3 8 8 10.3 13 8M3 11 8 13.3 13 11"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            相似款 {duplicateCount}
          </span>
        ) : null}
        {typeof product.inStock === 'boolean' ? (
          <span
            title={product.stockText ?? (product.inStock ? '有货' : '缺货')}
            className={`absolute bottom-2 left-2 z-[1] inline-flex h-2.5 w-2.5 rounded-full shadow-sm ${
              product.inStock ? 'bg-emerald-500' : 'bg-zinc-400'
            }`}
          />
        ) : null}
      </div>
      <div className="space-y-1 p-2.5">
        <p className="line-clamp-1 text-xs font-medium text-zinc-900">{product.title}</p>
        <p className="line-clamp-1 text-[11px] text-zinc-500">
          {[product.brand, product.series].filter((s) => s && s !== '品牌待确认' && s !== '系列待确认').join(' · ') || '—'}
        </p>
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-sm font-semibold text-[#5E6AD2]">
            {product.price}
            {product.currency && !/^(CNY|USD|EUR|JPY|GBP|KRW|[¥￥$€£₩])/i.test(product.price) ? (
              <span className="ml-1 text-[10px] font-normal text-zinc-400">{product.currency}</span>
            ) : null}
          </span>
          <span className="text-[10px] text-zinc-400">{product.galleryImages.length} 图</span>
        </div>
      </div>
    </div>
  );
}
