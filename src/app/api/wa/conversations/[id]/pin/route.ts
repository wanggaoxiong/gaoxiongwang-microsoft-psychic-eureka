import { NextResponse } from 'next/server';
import { toggleConversationPinned } from '@/lib/wa/store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/wa/conversations/:id/pin —— 切换会话置顶
 * 返回 { ok, pinned }
 */
export async function POST(_request: Request, ctx: { params: { id: string } }) {
  const id = decodeURIComponent(ctx.params.id);
  const r = await toggleConversationPinned(id);
  if (!r) return NextResponse.json({ ok: false, reason: 'conversation not found' }, { status: 404 });
  return NextResponse.json({ ok: true, pinned: r.pinned });
}
