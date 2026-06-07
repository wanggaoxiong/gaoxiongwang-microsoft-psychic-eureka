import { NextResponse } from 'next/server';
import { loadPaymentConfig, savePaymentConfig, paymentConfigSchema } from '@/lib/payments/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const config = await loadPaymentConfig();
  return NextResponse.json({ ok: true, config });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const parsed = paymentConfigSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'invalid', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const saved = await savePaymentConfig(parsed.data);
    return NextResponse.json({ ok: true, config: saved });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    );
  }
}
