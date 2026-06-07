import { NextResponse } from 'next/server';
import { setConversationDraft } from '@/lib/wa/store';

/**
 * DELETE /api/wa/conversations/[id]/draft
 * 清空该会话的 AI 草稿。前端在 DRAFT_AUTO 模式下把草稿填进输入框之后立刻调用本接口，
 * 避免下次轮询又把同样的草稿再填一遍。
 */
export const dynamic = 'force-dynamic';

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    await setConversationDraft(params.id, null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : '清除草稿失败' },
      { status: 500 }
    );
  }
}
