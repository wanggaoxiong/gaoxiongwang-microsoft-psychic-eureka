import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listContacts, upsertContact, listTags } from '@/lib/contacts/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') ?? undefined;
  const tag = searchParams.get('tag') ?? undefined;
  const verifiedRaw = searchParams.get('verified');
  const verified =
    verifiedRaw === 'yes' || verifiedRaw === 'no' || verifiedRaw === 'unknown'
      ? verifiedRaw
      : undefined;
  const [contacts, tags] = await Promise.all([
    listContacts({ q, tag, verified }),
    listTags()
  ]);
  return NextResponse.json({ contacts, tags });
}

const createSchema = z.object({
  phone: z.string().optional(),
  lid: z.string().optional(),
  name: z.string().optional(),
  company: z.string().optional(),
  position: z.string().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.enum(['manual', 'inbox', 'import', 'ai']).optional()
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  try {
    const result = await upsertContact(parsed.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
