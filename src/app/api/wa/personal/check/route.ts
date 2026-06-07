import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkPersonalNumber } from '@/lib/wa/personal-client';

const schema = z.object({ to: z.string().min(5) });

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const r = await checkPersonalNumber(body.to);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
    return NextResponse.json({ registered: r.registered });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '参数错误' },
      { status: 400 }
    );
  }
}
