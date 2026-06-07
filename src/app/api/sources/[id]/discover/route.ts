import { NextResponse } from 'next/server';
import { appendDiscoveries, type DiscoveredProduct } from '@/lib/sources/discovery';
import { crawlSourceListing } from '@/lib/sources/crawler';
import { mockSupplierSources } from '@/mocks/supplierCatalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/sources/[id]/discover
 *
 * 真爬虫：
 *   1) 用 Playwright 打开 source 的列表/主页（默认 websiteUrl，可通过 body.listingUrl 覆盖）
 *   2) 自动下滑触发懒加载
 *   3) 用站点对应的 DetailRule 匹配出 detail page 锚点 + 主图
 *   4) 写入 data/source-discoveries.json（按 sourceId+code 去重）
 *
 * Body (可选): { listingUrl?: string }
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const sourceId = params.id;
  const source = mockSupplierSources.find((s) => s.id === sourceId);
  if (!source) {
    return NextResponse.json({ error: '未知 source' }, { status: 404 });
  }

  let body: { listingUrl?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* 没 body 也行 */
  }

  const listingUrl = body.listingUrl?.trim() || source.websiteUrl;
  const startedAt = Date.now();

  // 对 90ii 分类页做翻页：抓 ?page=1, ?page=2 ... 直到空或安全上限
  const isNinetyIiCategory =
    sourceId === '90ii' && /\/categories\/\d+/.test(listingUrl);

  let crawl;
  let pagesScanned = 0;
  try {
    if (isNinetyIiCategory) {
      const base = new URL(listingUrl);
      const merged: any = {
        startUrl: listingUrl,
        scannedAnchors: 0,
        scannedImages: 0,
        scannedJsonResponses: 0,
        scannedXhrRequests: 0,
        scannedCards: 0,
        sampleXhrUrls: [] as string[],
        candidates: [] as any[],
        via: 'card',
        warnings: [] as string[]
      };
      const seenCodes = new Set<string>();
      const MAX_PAGES = 10;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = new URL(base.toString());
        url.searchParams.set('page', String(page));
        const r = await crawlSourceListing(sourceId, url.toString());
        pagesScanned += 1;
        merged.scannedAnchors += r.scannedAnchors;
        merged.scannedImages += r.scannedImages;
        merged.scannedJsonResponses += r.scannedJsonResponses;
        merged.scannedXhrRequests += r.scannedXhrRequests;
        merged.scannedCards += r.scannedCards;
        if (r.warnings.length) merged.warnings.push(`page${page}: ${r.warnings.join('; ')}`);
        let newOnThisPage = 0;
        for (const c of r.candidates) {
          if (seenCodes.has(c.sourceCode)) continue;
          seenCodes.add(c.sourceCode);
          merged.candidates.push(c);
          newOnThisPage += 1;
        }
        if (newOnThisPage === 0) break;
      }
      crawl = merged;
    } else {
      crawl = await crawlSourceListing(sourceId, listingUrl);
    }
  } catch (err: any) {
    return NextResponse.json(
      {
        error: '爬虫失败',
        reason: err?.message ?? String(err),
        listingUrl
      },
      { status: 500 }
    );
  }

  const now = new Date().toISOString();
  const items: DiscoveredProduct[] = crawl.candidates.map((c: {
    sourceCode: string;
    detailUrl?: string;
    mainImage?: string;
    title?: string;
    priceHint?: string;
    merchantHint?: string;
  }) => ({
    id: `${sourceId}:${c.sourceCode}`,
    sourceId,
    sourceCode: c.sourceCode,
    detailUrl: c.detailUrl,
    mainImage: c.mainImage,
    title: c.title,
    price: c.priceHint,
    merchant: c.merchantHint,
    brandHint: undefined,
    discoveredAt: now
  }));

  const added = await appendDiscoveries(items);

  return NextResponse.json({
    ok: true,
    listingUrl,
    finalUrl: crawl.startUrl,
    elapsedMs: Date.now() - startedAt,
    scannedAnchors: crawl.scannedAnchors,
    scannedImages: crawl.scannedImages,
    scannedJsonResponses: crawl.scannedJsonResponses,
    scannedXhrRequests: crawl.scannedXhrRequests,
    scannedCards: crawl.scannedCards,
    sampleXhrUrls: crawl.sampleXhrUrls,
    scanned: items.length,
    added,
    skipped: items.length - added,
    pagesScanned: pagesScanned || 1,
    via: crawl.via,
    warnings: crawl.warnings,
    discoveredAt: now
  });
}
