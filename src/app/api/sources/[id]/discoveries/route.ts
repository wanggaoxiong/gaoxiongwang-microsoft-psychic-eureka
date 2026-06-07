import { NextResponse } from 'next/server';
import { clearDiscoveries, countBySource, listDiscoveries } from '@/lib/sources/discovery';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const sourceId = params.id;
  const [items, counts] = await Promise.all([
    listDiscoveries(sourceId),
    countBySource(sourceId)
  ]);
  return NextResponse.json({ items, counts });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const removed = await clearDiscoveries(params.id);
  return NextResponse.json({ ok: true, removed });
}
