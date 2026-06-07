import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sendReaction, isPersonalReady } from '@/lib/wa/personal-client';

/**
 * POST /api/wa/reaction
 * body: { messageId: string, emoji: string }
 * - emoji = '' 表示取消我之前的 reaction
 * - 仅 personal 模式可用（Cloud API 暂未实现 reaction）
 */
const schema = z.object({
  messageId: z.string().min(1),
  emoji: z.string().max(8) // 单个 emoji 含组合一般不超过 8 字符
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: parsed.error.message }, { status: 400 });
  }
  if (!isPersonalReady()) {
    return NextResponse.json({ ok: false, reason: 'personal client 未就绪' }, { status: 409 });
  }
  const r = await sendReaction(parsed.data.messageId, parsed.data.emoji);
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
