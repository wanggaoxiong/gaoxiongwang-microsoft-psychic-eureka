import { NextResponse } from 'next/server';
import { loadPricingStrategy, savePricingStrategy } from '@/lib/pricing/store';
import { pricingStrategySchema } from '@/lib/pricing/engine';

export const dynamic = 'force-dynamic';

export async function GET() {
  const strategy = await loadPricingStrategy();
  return NextResponse.json({ ok: true, strategy });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const parsed = pricingStrategySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: 'invalid', issues: parsed.error.issues }, { status: 400 });
    }
    const saved = await savePricingStrategy(parsed.data);
    return NextResponse.json({ ok: true, strategy: saved });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'unknown' }, { status: 500 });
  }
}
