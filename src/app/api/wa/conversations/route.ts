import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listConversations, appendIncoming } from '@/lib/wa/store';

export async function GET() {
  const conversations = await listConversations();
  return NextResponse.json({ conversations });
}

// dev helper：模拟一条对端来信（线上靠 /api/wa/webhook 自动接）
const simSchema = z.object({
  from: z.string().min(3),
  name: z.string().optional(),
  text: z.string().min(1)
});

export async function POST(request: Request) {
  const parsed = simSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: parsed.error.message }, { status: 400 });
  }
  const msg = await appendIncoming({
    conversationId: parsed.data.from.replace(/\D/g, ''),
    name: parsed.data.name,
    text: parsed.data.text
  });
  return NextResponse.json({ ok: true, message: msg });
}
