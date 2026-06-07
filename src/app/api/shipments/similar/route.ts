import { NextResponse } from 'next/server';
import { findSimilarShipments } from '@/lib/shipments/store';

export const dynamic = 'force-dynamic';

/**
 * AI / 内部使用：根据国家 + 重量 + 关键词，返回最像的历史发货票，作为报价锚点。
 * 示例：POST { "country":"GB", "weightKg":2.5, "keyword":"手提包", "carrierId":"uk-royal", "limit":5 }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const items = await findSimilarShipments({
      country: body.country,
      weightKg: body.weightKg,
      carrierId: body.carrierId,
      keyword: body.keyword,
      limit: body.limit ?? 5
    });
    return NextResponse.json({ ok: true, items, count: items.length });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'unknown' }, { status: 400 });
  }
}
