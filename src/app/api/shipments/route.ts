import { NextResponse } from 'next/server';
import { searchShipments, shipmentStats } from '@/lib/shipments/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  if (sp.get('stats') === '1') {
    return NextResponse.json({ ok: true, stats: await shipmentStats() });
  }
  const items = await searchShipments({
    q: sp.get('q') ?? undefined,
    country: sp.get('country') ?? undefined,
    carrier: sp.get('carrier') ?? undefined,
    weightMinKg: sp.get('weightMin') ? Number(sp.get('weightMin')) : undefined,
    weightMaxKg: sp.get('weightMax') ? Number(sp.get('weightMax')) : undefined,
    dateFrom: sp.get('dateFrom') ?? undefined,
    dateTo: sp.get('dateTo') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : 200
  });
  return NextResponse.json({ ok: true, items, count: items.length });
}
