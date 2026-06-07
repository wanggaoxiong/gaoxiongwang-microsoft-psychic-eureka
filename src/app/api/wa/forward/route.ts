import { NextResponse } from 'next/server';
import { z } from 'zod';
import { forwardMessage, isPersonalReady } from '@/lib/wa/personal-client';

/**
 * POST /api/wa/forward
 * body: { messageId: string, toConversationIds: string[] }
 * 把一条本地消息（必须有 waMessageId）转发到一个或多个会话。
 * 仅 personal 模式可用。
 */
const schema = z.object({
  messageId: z.string().min(1),
  toConversationIds: z.array(z.string().min(1)).min(1).max(20)
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
  const r = await forwardMessage(parsed.data.messageId, parsed.data.toConversationIds);
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
