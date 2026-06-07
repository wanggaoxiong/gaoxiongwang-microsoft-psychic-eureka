import { NextResponse } from 'next/server';
import { calculatePrice } from '@/lib/pricing/engine';
import { loadPricingStrategy } from '@/lib/pricing/store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const strategy = await loadPricingStrategy();
    const result = calculatePrice(strategy, body);
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'unknown' }, { status: 400 });
  }
}
