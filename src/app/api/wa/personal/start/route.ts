import { NextResponse } from 'next/server';
import { startPersonalClient, getPersonalStatus } from '@/lib/wa/personal-client';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    // 解析可选 body：{ useProxy?: boolean, force?: boolean }，默认 useProxy=true，force=false
    let useProxy: boolean | undefined;
    let force: boolean | undefined;
    try {
      const ct = req.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const body = (await req.json()) as { useProxy?: unknown; force?: unknown };
        if (typeof body?.useProxy === 'boolean') useProxy = body.useProxy;
        if (typeof body?.force === 'boolean') force = body.force;
      }
    } catch {
      /* body 解析失败按默认处理 */
    }
    await startPersonalClient({ useProxy, force });
    return NextResponse.json({ ok: true, ...getPersonalStatus() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
