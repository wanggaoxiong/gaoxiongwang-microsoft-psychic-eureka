import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteContactOrder, updateContactOrder } from '@/lib/contacts/store';

export const dynamic = 'force-dynamic';

const statusEnum = z.enum(['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']);

const patchSchema = z.object({
  orderNo: z.string().optional(),
  trackingNo: z.string().optional(),
  carrier: z.string().optional(),
  items: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
  status: statusEnum.optional(),
  note: z.string().optional(),
  placedAt: z.number().optional(),
  shippedAt: z.number().optional(),
  deliveredAt: z.number().optional()
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string; orderId: string } }
) {
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
  const updated = await updateContactOrder(params.id, params.orderId, parsed.data);
  if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ contact: updated });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; orderId: string } }
) {
  const updated = await deleteContactOrder(params.id, params.orderId);
  if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ contact: updated });
}
