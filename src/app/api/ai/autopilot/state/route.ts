import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getAutopilotState,
  setKillSwitch,
  setDefaultAutoMode,
  pauseConversationAutopilot,
  AUTO_MODES,
  type AutoMode
} from '@/lib/ai/autopilot';

/**
 * GET  /api/ai/autopilot/state  ── \u8bfb\u53d6\u5168\u5c40 autopilot \u72b6\u6001\uff08kill switch / \u9ed8\u8ba4\u6863\u4f4d / \u4f1a\u8bdd\u6682\u505c\u8868\uff09
 * POST /api/ai/autopilot/state  ── \u4fee\u6539\u72b6\u6001\uff0c\u4e09\u79cd\u52a8\u4f5c\u4e8c\u9009\u4e00\uff1a
 *   - { action: 'kill', on: boolean }            \u5168\u5c40\u6025\u505c
 *   - { action: 'defaultMode', mode: AutoMode }  \u8bbe\u5168\u5c40\u9ed8\u8ba4\u6863\u4f4d
 *   - { action: 'pauseConv', conversationId, minutes }  \u6682\u505c\u67d0\u4f1a\u8bdd\uff0cminutes=0 \u6e05\u9664
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('kill'), on: z.boolean() }),
  z.object({
    action: z.literal('defaultMode'),
    mode: z.enum(AUTO_MODES as [AutoMode, ...AutoMode[]])
  }),
  z.object({
    action: z.literal('pauseConv'),
    conversationId: z.string().min(1),
    minutes: z.number().int().min(0).max(60 * 24 * 30)
  })
]);

export async function GET() {
  const state = await getAutopilotState();
  return NextResponse.json(state);
}

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
  const input = parsed.data;
  let state;
  if (input.action === 'kill') {
    state = await setKillSwitch(input.on);
  } else if (input.action === 'defaultMode') {
    state = await setDefaultAutoMode(input.mode);
  } else {
    state = await pauseConversationAutopilot(
      input.conversationId,
      input.minutes * 60 * 1000
    );
  }
  return NextResponse.json({ ok: true, state });
}
