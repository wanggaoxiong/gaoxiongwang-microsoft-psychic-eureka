import { NextResponse } from 'next/server';
import { removeProfile } from '@/lib/wa/profiles';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  try {
    await removeProfile(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
