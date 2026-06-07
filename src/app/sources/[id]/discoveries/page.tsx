'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Empty, Input } from '@/lib/ui/primitives';
import type { DiscoveredProduct } from '@/lib/sources/discovery';
import { loadAiConfig, getEffectiveModel, isAiConfigured } from '@/lib/ai/config';

function azurePayload() {
  const cfg = loadAiConfig();
  if (!isAiConfigured(cfg)) return undefined;
  return {
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: getEffectiveModel(cfg)
  };
}

type Resp = {
  items: DiscoveredProduct[];
  counts: { total: number; pending: number };
};

const DEFAULT_LISTING: Record<string, string> = {
  gxhyapp: 'https://mall.gxhyapp.com/market/web/Screening?marketCode=gz&typeid=7',
  '90ii': 'https://www.90ii.net/categories/615'
};

export default function DiscoveriesPage({ params }: { params: { id: string } }) {
  const sourceId = params.id;
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [normalizingId, setNormalizingId] = useState<string | null>(null);
  const [batchNormalizing, setBatchNormalizing] = useState(false);
  const [pageSize, setPageSize] = useState<number | 'all'>(20);
  const [pageIndex, setPageIndex] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [listingUrl, setListingUrl] = useState(DEFAULT_LISTING[sourceId] ?? '');
  // 批量提取状态：进度、停止开关、多选
  const [batchProgress, setBatchProgress] = useState<{
    total: number;
    done: number;
    failed: number;
    currentLabel: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function fetchList(opts?: { silent?: boolean }) {
    if (!opts?.silent) setLoading(true);
    try {
      const r = await fetch(`/api/sources/${sourceId}/discoveries`, { cache: 'no-store' });
      const j = (await r.json()) as Resp;
      setData(j);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }

  useEffect(() => {
    fetchList();
  }, [sourceId]);

  async function rescan() {
    setScanning(true);
    setToast(null);
    try {
      const r = await fetch(`/api/sources/${sourceId}/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingUrl: listingUrl || undefined })
      });
      const j = await r.json();
      if (j.ok) {
        setToast(
          `扫描完成（${j.elapsedMs}ms、通道=${j.via}）：XHR ${j.scannedXhrRequests ?? 0} / JSON ${j.scannedJsonResponses ?? 0} / 卡片 ${j.scannedCards ?? 0} / 链接 ${j.scannedAnchors} / 图 ${j.scannedImages}，匹配 ${j.scanned} 件，新增 ${j.added}`
        );
        if (Array.isArray(j.sampleXhrUrls) && j.sampleXhrUrls.length > 0 && j.scanned === 0) {
          // eslint-disable-next-line no-console
          console.log('[discover] sample XHR urls:', j.sampleXhrUrls);
        }
        if (Array.isArray(j.warnings) && j.warnings.length > 0) {
          // eslint-disable-next-line no-console
          console.log('[discover] warnings:', j.warnings);
        }
      } else {
        setToast(`扫描失败：${j.error ?? '未知错误'} ${j.reason ? `· ${j.reason}` : ''}`);
      }
      await fetchList();
    } catch (e: any) {
      setToast(`扫描异常：${e?.message ?? e}`);
    } finally {
      setScanning(false);
    }
  }

  async function openLogin() {
    setLoggingIn(true);
    setToast('已启动登录窗口；完成操作后请关闭弹出的页面/窗口，系统才会保存 session 并结束“登录中”。');
    try {
      const r = await fetch(`/api/sources/${sourceId}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginUrl: listingUrl || undefined })
      });
      const j = await r.json();
      if (j.ok) {
        setToast(`session ${j.saved ? '已保存' : '未保存'}：${j.stateFile}`);
      } else {
        setToast(`登录失败：${j.error ?? ''} ${j.reason ?? ''} ${j.hint ?? ''}`);
      }
    } catch (e: any) {
      setToast(`登录异常：${e?.message ?? e}`);
    } finally {
      setLoggingIn(false);
    }
  }

  async function normalizeOne(it: DiscoveredProduct) {
    setNormalizingId(it.id);
    setToast(null);
    try {
      const r = await fetch(`/api/sources/${sourceId}/discoveries/normalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [it.id], azure: azurePayload() })
      });
      const j = await r.json();
      if (j.ok && j.succeeded > 0) {
        setToast(`已提取：${it.sourceCode}（${j.elapsedMs}ms）`);
      } else {
        const reason = j.results?.[0]?.reason ?? j.error ?? '未知错误';
        setToast(`提取失败：${reason}`);
      }
      await fetchList({ silent: true });
    } catch (e: any) {
      setToast(`提取异常：${e?.message ?? e}`);
    } finally {
      setNormalizingId(null);
    }
  }

  async function normalizeAll() {
    const pending = (data?.items ?? []).filter((it) => !it.enriched?.normalizedAt);
    if (pending.length === 0) {
      setToast('没有未提取的发现商品');
      return;
    }
    await runBatch(pending, '未提取的全部');
  }

  async function normalizeSelected() {
    const list = (data?.items ?? []).filter((it) => selectedIds.has(it.id));
    if (list.length === 0) return;
    await runBatch(list, `选中的 ${list.length} 件`);
  }

  /**
   * 客户端逐个发请求，每个请求用 AbortController 可控（点「停止」会中断当前并跳出循环）。
   * 这样 token 消耗上限 = 已处理数 × 单件成本，远比 server-side 一口气跑完可控。
   */
  async function runBatch(targets: DiscoveredProduct[], label: string) {
    if (targets.length === 0) return;
    if (!confirm(`将对 ${label}（${targets.length} 件）逐个调用 AI 抽取信息，可随时「停止」。继续？`)) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBatchNormalizing(true);
    setBatchProgress({ total: targets.length, done: 0, failed: 0, currentLabel: '' });
    setToast(null);
    const azure = azurePayload();
    let done = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      if (ctrl.signal.aborted) break;
      const it = targets[i];
      setBatchProgress({
        total: targets.length,
        done,
        failed,
        currentLabel: it.enriched?.title || it.title || it.sourceCode
      });
      try {
        const r = await fetch(`/api/sources/${sourceId}/discoveries/normalize`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [it.id], azure })
        });
        const j = await r.json();
        if (j.ok && j.succeeded > 0) done += 1;
        else failed += 1;
      } catch (e: any) {
        if (ctrl.signal.aborted) break;
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn('[batch normalize] failed', it.sourceCode, e);
      }
    }
    const aborted = ctrl.signal.aborted;
    abortRef.current = null;
    setBatchProgress(null);
    setBatchNormalizing(false);
    setToast(
      aborted
        ? `已停止：成功 ${done}，失败 ${failed}，剩余 ${targets.length - done - failed} 件未处理`
        : `批量提取完成：成功 ${done}，失败 ${failed}（共 ${targets.length} 件）`
    );
    await fetchList({ silent: true });
  }

  function stopBatch() {
    abortRef.current?.abort();
  }

  async function clearAll() {
    if (!confirm(`确认清空 ${sourceId} 的所有候选商品？`)) return;
    const r = await fetch(`/api/sources/${sourceId}/discoveries`, { method: 'DELETE' });
    const j = await r.json();
    setToast(`已清空 ${j.removed} 条候选`);
    await fetchList();
  }

  async function promote(item: DiscoveredProduct) {
    setBusyId(item.id);
    setToast(null);
    try {
      let card: any = null;
      // 优先用已归一化的快照；如果还没提取过，先走一次 scrape+归一化
      if (item.enriched?.normalizedAt) {
        card = {
          mainImage: item.enriched.mainImage,
          title: item.enriched.title,
          brand: item.enriched.brand,
          series: item.enriched.series,
          model: item.enriched.model,
          skuCode: item.sourceCode,
          categoryPath: item.enriched.categoryPath ?? [],
          price: item.enriched.price,
          merchant: item.enriched.merchant,
          galleryImages: item.enriched.galleryImages ?? [],
          descriptionBullets: item.enriched.descriptionBullets ?? [],
          searchKeywords: item.enriched.searchKeywords,
          useCase: item.enriched.useCase,
          bestForCustomerType: item.enriched.bestForCustomerType,
          extractedAttributes: [],
          confidence: {
            overall: item.enriched.confidenceOverall ?? 0,
            source: item.enriched.confidenceSource ?? 'heuristic'
          },
          sourceUrl: item.detailUrl
        };
      } else {
        const scrape = await fetch('/api/suppliers/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: item.sourceId,
            url: item.detailUrl,
            code: item.sourceCode,
            azure: azurePayload()
          })
        });
        if (!scrape.ok) {
          setToast(`抓取失败：${scrape.status}`);
          return;
        }
        const j = (await scrape.json()) as any;
        card = j.card;
      }
      const upsert = await fetch('/api/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: item.sourceId,
          sourceCode: item.sourceCode,
          sourceUrl: card.sourceUrl ?? item.detailUrl,
          mainImage: card.mainImage ?? item.mainImage,
          galleryImages: card.galleryImages ?? [],
          title: card.title ?? item.title ?? '',
          brand: card.brand ?? item.brandHint ?? '',
          series: card.series ?? '',
          model: card.model ?? '',
          skuCode: card.skuCode ?? item.sourceCode,
          categoryPath: card.categoryPath ?? [],
          price: card.price ?? item.price ?? '',
          merchant: card.merchant ?? item.merchant ?? '',
          attributes: card.extractedAttributes ?? [],
          gender: card.gender,
          colors: card.colors,
          sizes: card.sizes,
          materials: card.materials,
          targetAudience: card.targetAudience,
          descriptionBullets: card.descriptionBullets,
          searchKeywords: card.searchKeywords,
          useCase: card.useCase,
          bestForCustomerType: card.bestForCustomerType,
          currency: card.currency,
          inStock: card.inStock,
          stockText: card.stockText,
          // 把现有中文字段当 zh 翻译缓存预先种下，避免用户点 zh 标签时再走 LLM
          localizations: {
            zh: {
              title: card.title ?? item.title,
              series: card.series,
              categoryPath: card.categoryPath ?? [],
              gender: card.gender,
              colors: card.colors,
              sizes: card.sizes,
              materials: card.materials,
              targetAudience: card.targetAudience,
              descriptionBullets: card.descriptionBullets,
              attributes: card.extractedAttributes ?? [],
              stockText: card.stockText
            }
          },
          confidence: card.confidence?.overall ?? 0,
          confidenceSource: card.confidence?.source ?? 'heuristic',
          confidenceNotes: card.confidence?.notes,
          discoveryId: item.id
        })
      });
      if (!upsert.ok) {
        setToast(`入库失败：${upsert.status}`);
        return;
      }
      setToast(`已加入 Catalog：${card.title ?? item.title ?? item.sourceCode}`);
      await fetchList({ silent: true });
    } catch (e: any) {
      setToast(`异常：${e?.message ?? e}`);
    } finally {
      setBusyId(null);
    }
  }

  const items = data?.items ?? [];
  const effectivePageSize = pageSize === 'all' ? items.length || 1 : pageSize;
  const pageCount = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(items.length / effectivePageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleItems =
    pageSize === 'all'
      ? items
      : items.slice(safePageIndex * effectivePageSize, (safePageIndex + 1) * effectivePageSize);

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-8 py-4 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              href="/sources"
              className="text-xs text-zinc-400 hover:text-[#5E6AD2]"
            >
              ← Sources
            </Link>
            <h1 className="mt-1 text-base font-semibold text-zinc-950">
              {sourceId} · 发现池
            </h1>
            <p className="text-xs text-zinc-500">
              {data
                ? `共 ${data.counts.total} 件候选，${data.counts.pending} 件待加入 Catalog`
                : '加载中…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="md" onClick={openLogin} disabled={loggingIn || scanning}>
              {loggingIn ? '登录中…' : '登录会话'}
            </Button>
            {/* 智能 AI 提取按钮：选中态优先，否则全量未提取；运行时切换为「停止」 */}
            {batchNormalizing ? (
              <Button variant="danger" size="md" onClick={stopBatch}>
                停止提取
              </Button>
            ) : (() => {
              const pendingCount = items.filter((it) => !it.enriched?.normalizedAt).length;
              const useSelected = selectedIds.size > 0;
              const targetCount = useSelected ? selectedIds.size : pendingCount;
              const label = useSelected
                ? `AI 提取选中 (${selectedIds.size})`
                : `AI 提取未提取 (${pendingCount})`;
              const tip = useSelected
                ? '逐个调用 AI 提取已勾选的商品（可随时停止）'
                : '逐个调用 AI 提取尚未入库的发现商品（可随时停止）';
              return (
                <Button
                  variant="primary"
                  size="md"
                  onClick={useSelected ? normalizeSelected : normalizeAll}
                  disabled={scanning || targetCount === 0}
                  title={tip}
                >
                  {label}
                </Button>
              );
            })()}
            {selectedIds.size > 0 && !batchNormalizing ? (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline"
              >
                清除选中
              </button>
            ) : null}
            <Button variant="ghost" size="md" onClick={clearAll}>
              清空
            </Button>
            <Button variant="primary" size="md" onClick={rescan} disabled={scanning}>
              {scanning ? '扫描中…' : '重新扫描'}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={listingUrl}
            onChange={(e) => setListingUrl(e.target.value)}
            placeholder="列表页/主页 URL（留空则用 source 的 websiteUrl）"
            className="flex-1"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-400">
          爬虫会用 Playwright 打开此 URL → 抓取所有 JSON 响应（商品列表 API）为主，DOM
          <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 font-mono">a[href]</code>
          为辅。如遇空试试具体分类/商家页
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>每页显示</span>
          {[8, 10, 16, 20, 24].map((n) => (
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
        </div>
        {toast ? (
          <div className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
            {toast}
          </div>
        ) : null}
        {batchProgress ? (
          <div className="mt-3 rounded-md border border-[#5E6AD2]/40 bg-[#5E6AD2]/5 px-3 py-2">
            <div className="flex items-center justify-between text-xs text-zinc-700">
              <span>
                正在提取：<strong>{batchProgress.done + batchProgress.failed} / {batchProgress.total}</strong>
                {batchProgress.failed > 0 ? <span className="ml-2 text-amber-700">失败 {batchProgress.failed}</span> : null}
              </span>
              <span className="truncate text-[11px] text-zinc-500">{batchProgress.currentLabel}</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-zinc-200">
              <div
                className="h-full bg-[#5E6AD2] transition-all"
                style={{ width: `${Math.round(((batchProgress.done + batchProgress.failed) / Math.max(1, batchProgress.total)) * 100)}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="px-8 py-6">
        {loading ? (
          <p className="text-sm text-zinc-400">加载中…</p>
        ) : items.length === 0 ? (
          <Empty
            title="还没有发现的商品"
            description="点 '重新扫描' 让爬虫沿着主页 / 列表页爬一遍候选商品"
            action={
              <Button variant="primary" onClick={rescan} disabled={scanning}>
                立即扫描
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleItems.map((it) => {
              const hasEnriched = !!it.enriched?.normalizedAt;
              // 入库后又重新提取过 → 视为有更新，允许重新入库覆盖
              const reExtractedAfterAdd =
                !!it.catalogProductId &&
                hasEnriched &&
                !!it.catalogAddedAt &&
                (it.enriched?.normalizedAt ?? '') > it.catalogAddedAt;
              const canPromote =
                hasEnriched && (!it.catalogProductId || reExtractedAfterAdd);
              const promoteLabel = reExtractedAfterAdd
                ? '覆盖入库'
                : it.catalogProductId
                ? '已入库'
                : '加入 Catalog';
              const promoteDisabledReason = !hasEnriched
                ? '请先 AI 提取商品信息'
                : it.catalogProductId && !reExtractedAfterAdd
                ? '已在 Catalog 中（如需更新请先 AI 重新提取）'
                : '';

              function onImageClick() {
                if (it.catalogProductId) {
                  router.push(`/catalog?focus=${encodeURIComponent(it.catalogProductId)}`);
                } else {
                  setToast('该商品尚未加入 Catalog');
                }
              }

              return (
              <Card key={it.id} className="relative overflow-hidden">
                {/* 多选复选框：选中后可点「提取选中」批量跑 */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelected(it.id);
                  }}
                  aria-label={selectedIds.has(it.id) ? '取消选中' : '选中'}
                  className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded border shadow-sm transition ${
                    selectedIds.has(it.id)
                      ? 'border-[#5E6AD2] bg-[#5E6AD2]'
                      : 'border-zinc-300 bg-white/95 opacity-80 hover:opacity-100'
                  }`}
                >
                  {selectedIds.has(it.id) ? (
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="2.5 6.5 5 9 9.5 3.5" />
                    </svg>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={onImageClick}
                  title={it.catalogProductId ? '在 Catalog 中查看' : '尚未加入 Catalog'}
                  className="block aspect-square w-full overflow-hidden bg-zinc-50"
                >
                  {it.mainImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={it.mainImage}
                      alt={it.title ?? it.sourceCode}
                      className="h-full w-full object-cover transition hover:scale-105"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-zinc-300">
                      无主图
                    </div>
                  )}
                </button>
                <div className="space-y-2 p-3">
                  <p className="line-clamp-2 text-sm font-semibold text-zinc-900">
                    {it.enriched?.title || it.title || it.sourceCode}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {(it.enriched?.brand || it.brandHint) ? (
                      <Badge tone="accent">{it.enriched?.brand || it.brandHint}</Badge>
                    ) : null}
                    {it.enriched?.categoryPath?.[0] || it.categoryHint ? (
                      <Badge tone="muted">
                        {it.enriched?.categoryPath?.[0] || it.categoryHint}
                      </Badge>
                    ) : null}
                    {(it.enriched?.price || it.price) ? (
                      <Badge tone="success">{it.enriched?.price || it.price}</Badge>
                    ) : null}
                    {it.enriched?.galleryImages && it.enriched.galleryImages.length > 0 ? (
                      <Badge tone="muted">{it.enriched.galleryImages.length} 图</Badge>
                    ) : null}
                    {it.merchant ? <Badge tone="muted">{it.merchant}</Badge> : null}
                  </div>
                  <p className="truncate font-mono text-[10px] text-zinc-400">
                    {it.sourceCode}
                    {it.enriched?.normalizedAt ? ' · 已提取' : ''}
                    {it.catalogProductId ? ' · 已入库' : ''}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant={canPromote ? 'primary' : 'ghost'}
                      onClick={() => promote(it)}
                      disabled={busyId === it.id || !canPromote}
                      title={promoteDisabledReason || undefined}
                    >
                      {busyId === it.id ? '处理中…' : promoteLabel}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => normalizeOne(it)}
                      disabled={normalizingId === it.id || batchNormalizing}
                    >
                      {normalizingId === it.id
                        ? '提取中…'
                        : hasEnriched
                        ? 'AI 重新提取'
                        : 'AI 提取商品信息'}
                    </Button>
                    {it.catalogProductId ? (
                      <Link
                        href={`/catalog?focus=${encodeURIComponent(it.catalogProductId)}`}
                        className="text-xs text-zinc-400 hover:text-[#5E6AD2]"
                      >
                        Catalog ↗
                      </Link>
                    ) : null}
                    <a
                      href={it.detailUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-zinc-400 hover:text-[#5E6AD2]"
                    >
                      详情页 ↗
                    </a>
                  </div>
                </div>
              </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
