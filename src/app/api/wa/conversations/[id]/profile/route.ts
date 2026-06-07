import { NextResponse } from 'next/server';
import { summarizeByConversationId } from '@/lib/contacts/profile';
import { resolveAzure } from '@/lib/ai/azure';

export const runtime = 'nodejs';

/**
 * POST /api/wa/conversations/[id]/profile
 *
 * 由 WA conversationId 生成「客户长期画像」，写入对应 contact.aiProfile。
 * 如果 CRM 里没有该联系人，会自动以 source='inbox' 建一条。
 * Body: { azure?, fallbackName? }
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      azure?: { endpoint?: string; apiKey?: string; model?: string };
      fallbackName?: string;
    };
    const cfg = resolveAzure(body.azure);
    if (!cfg) return NextResponse.json({ error: 'Azure 未配置' }, { status: 400 });
    const result = await summarizeByConversationId(
      decodeURIComponent(params.id),
      cfg,
      body.fallbackName
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, contact: result.contact });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
