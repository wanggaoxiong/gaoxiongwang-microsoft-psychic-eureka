import { NextResponse } from 'next/server';
import { verifyWebhookToken } from '@/lib/wa/cloud-api';
import { appendIncoming } from '@/lib/wa/store';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = verifyWebhookToken(
    url.searchParams.get('hub.mode'),
    url.searchParams.get('hub.verify_token'),
    url.searchParams.get('hub.challenge')
  );

  if (!challenge) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  return new NextResponse(challenge);
}

export async function POST(request: Request) {
  const payload = await request.json();
  const events = extractMessages(payload);

  for (const ev of events) {
    await appendIncoming({
      conversationId: ev.from,
      name: ev.name,
      text: ev.text,
      imageUrls: ev.imageUrl ? [ev.imageUrl] : undefined,
      type: ev.imageUrl ? 'image' : 'text',
      timestamp: ev.timestamp,
      id: ev.id
    });
  }

  return NextResponse.json({ ok: true, received: events.length });
}

function extractMessages(payload: unknown): Array<{
  id?: string;
  from: string;
  name?: string;
  text?: string;
  imageUrl?: string;
  timestamp?: number;
}> {
  const value = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
          messages?: Array<{
            id?: string;
            from?: string;
            timestamp?: string;
            text?: { body?: string };
            image?: { id?: string; link?: string };
          }>;
        };
      }>;
    }>;
  };

  const result: Array<{
    id?: string;
    from: string;
    name?: string;
    text?: string;
    imageUrl?: string;
    timestamp?: number;
  }> = [];

  for (const entry of value.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const contacts = change.value?.contacts ?? [];
      const nameMap = new Map<string, string>();
      for (const c of contacts) {
        if (c.wa_id && c.profile?.name) nameMap.set(c.wa_id, c.profile.name);
      }
      for (const m of change.value?.messages ?? []) {
        const from = m.from ?? 'unknown';
        result.push({
          id: m.id,
          from,
          name: nameMap.get(from),
          text: m.text?.body,
          imageUrl: m.image?.link,
          timestamp: m.timestamp ? Number(m.timestamp) * 1000 : Date.now()
        });
      }
    }
  }

  return result;
}
