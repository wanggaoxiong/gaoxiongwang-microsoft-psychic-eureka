import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setConversationAutoMode } from '@/lib/wa/store';
import { AUTO_MODES, type AutoMode } from '@/lib/ai/autopilot';

/**
 * POST /api/ai/autopilot/mode
 * \u4fee\u6539\u67d0\u4e2a\u4f1a\u8bdd\u7684 AI \u81ea\u52a8\u5316\u6863\u4f4d\u3002
 * - { conversationId, mode: 'OFF'|'SUGGEST'|'DRAFT_AUTO'|'AUTO_SAFE'|'AUTO_FULL' }
 * - mode = null \u4ee3\u8868\u6e05\u9664\uff08\u56de\u9000\u5230\u5168\u5c40\u9ed8\u8ba4\u503c\uff09
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  conversationId: z.string().min(1),
  mode: z.enum(AUTO_MODES as [AutoMode, ...AutoMode[]]).nullable()
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 }
    );
  }
  await setConversationAutoMode(parsed.data.conversationId, parsed.data.mode);
  return NextResponse.json({ ok: true });
}
