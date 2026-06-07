import { NextResponse } from 'next/server';
import { listDiscoveries, updateDiscovery, type DiscoveredProduct } from '@/lib/sources/discovery';
import { scrapeGxhyappDetail } from '@/lib/suppliers/gxhyapp/scraper';
import { scrapeNinetyIiDetail } from '@/lib/suppliers/ninetyii/scraper';
import { normalizeToProductCard } from '@/lib/suppliers/gxhyapp/normalizer';
import { mockSupplierSources } from '@/mocks/supplierCatalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/sources/[id]/discoveries/normalize
 *
 * Body:
 *   { ids: string[] }   — 归一化指定的发现池条目
 *   { ids: 'all', limit?: number, skipDone?: boolean } — 批量归一化所有
 *
 * 流程：scrape detail → LLM 归一化 → 写回 discovery.enriched
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const sourceId = params.id;
  const source = mockSupplierSources.find((s) => s.id === sourceId);
  if (!source) return NextResponse.json({ error: '未知 source' }, { status: 404 });

  let body: {
    ids?: string[] | 'all';
    limit?: number;
    skipDone?: boolean;
    azure?: { endpoint?: string; apiKey?: string; model?: string };
  } = {};
  try {
    body = await req.json();
  } catch {
    /* noop */
  }

  const all = await listDiscoveries(sourceId);
  let targets: DiscoveredProduct[];
  if (body.ids === 'all' || !body.ids) {
    targets = body.skipDone === false ? all : all.filter((it) => !it.enriched?.normalizedAt);
    if (body.limit) targets = targets.slice(0, body.limit);
  } else {
    const ids = new Set(body.ids);
    targets = all.filter((it) => ids.has(it.id));
  }

  const startedAt = Date.now();
  const results: Array<{ id: string; ok: boolean; reason?: string }> = [];

  for (const item of targets) {
    try {
      const raw =
        sourceId === '90ii'
          ? await scrapeNinetyIiDetail({ url: item.detailUrl, code: item.sourceCode })
          : await scrapeGxhyappDetail({
              url: item.detailUrl,
              code: item.sourceCode,
              // gxhyapp detailIndex 页是鉴权 Vue 壳，无 session 时拿不到商品数据，
              // 且列表抓到的 code 常不可靠（详情页与实际不符）。真正可用的信号是扫描时
              // 已拿到的 aliyizhan 主图——scraper 会据此枚举整组图交给 LLM 归一化。
              mainImageUrl: item.mainImage,
              useRenderer: true
            });
      const card = await normalizeToProductCard(raw, body.azure);
      const updated = await updateDiscovery(item.id, {
        title: card.title || item.title,
        mainImage: card.mainImage || item.mainImage,
        price: card.price || item.price,
        merchant: card.merchant || item.merchant,
        brandHint: card.brand || item.brandHint,
        categoryHint: card.categoryPath?.[0] || item.categoryHint,
        enriched: {
          title: card.title,
          brand: card.brand,
          series: card.series,
          model: card.model,
          mainImage: card.mainImage,
          galleryImages: card.galleryImages,
          price: card.price,
          categoryPath: card.categoryPath,
          merchant: card.merchant,
          descriptionBullets: card.descriptionBullets,
          searchKeywords: card.searchKeywords,
          useCase: card.useCase,
          bestForCustomerType: card.bestForCustomerType,
          normalizedAt: new Date().toISOString(),
          confidenceSource: card.confidence?.source,
          confidenceOverall: card.confidence?.overall
        }
      });
      results.push({ id: item.id, ok: !!updated });
    } catch (err: any) {
      results.push({ id: item.id, ok: false, reason: err?.message ?? String(err) });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: true,
    requested: targets.length,
    succeeded: okCount,
    failed: results.length - okCount,
    elapsedMs: Date.now() - startedAt,
    results
  });
}
