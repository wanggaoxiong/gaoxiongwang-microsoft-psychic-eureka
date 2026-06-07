import { NextResponse } from 'next/server';
import { listPersonalChats } from '@/lib/wa/personal-client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const includeGroups = url.searchParams.get('groups') === '1';
  const r = await listPersonalChats({ limit: Math.min(500, Math.max(1, limit)), includeGroups });
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json({ chats: r.chats ?? [] });
}
