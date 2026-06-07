import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteContact, getContact, updateContact } from '@/lib/contacts/store';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const c = await getContact(params.id);
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ contact: c });
}

const patchSchema = z.object({
  phone: z.string().nullable().optional(),
  lid: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  totalOrders: z.number().optional()
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const c = await updateContact(params.id, parsed.data);
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, contact: c });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ok = await deleteContact(params.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
