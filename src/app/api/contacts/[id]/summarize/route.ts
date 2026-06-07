import { NextResponse } from 'next/server';
import { summarizeContactById } from '@/lib/contacts/profile';
import { resolveAzure } from '@/lib/ai/azure';

export const runtime = 'nodejs';

/**
 * POST /api/contacts/[id]/summarize
 *
 * 用最近 50 条对话生成长期画像，写入 contact.aiProfile。
 * 仅在用户手动点击「总结客户」时调用——避免 AI 费用失控。
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      azure?: { endpoint?: string; apiKey?: string; model?: string };
    };
    const cfg = resolveAzure(body.azure);
    if (!cfg) return NextResponse.json({ error: 'Azure 未配置' }, { status: 400 });
    const result = await summarizeContactById(params.id, cfg);
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
