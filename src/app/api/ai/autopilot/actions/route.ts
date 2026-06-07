import { NextResponse } from 'next/server';
import { listAiActions } from '@/lib/ai/autopilot';

/**
 * GET /api/ai/autopilot/actions?limit=200
 * \u8fd4\u56de\u6700\u8fd1 N \u6761 AI \u53d1\u9001 / \u62e6\u622a / \u964d\u7ea7\u4e8b\u4ef6\uff0c\u9006\u5e8f\u3002
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
  const items = await listAiActions(limit);
  return NextResponse.json({ items });
}
