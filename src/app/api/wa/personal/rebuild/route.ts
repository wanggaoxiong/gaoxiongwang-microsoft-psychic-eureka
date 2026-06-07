import { NextResponse } from 'next/server';
import { rebuildConversationIndex } from '@/lib/wa/store';

export const dynamic = 'force-dynamic';

/** POST /api/wa/personal/rebuild —— 从 messages[] 反推所有会话条目，补齐缺失项 */
export async function POST() {
  const r = await rebuildConversationIndex();
  return NextResponse.json({ ok: true, ...r });
}
