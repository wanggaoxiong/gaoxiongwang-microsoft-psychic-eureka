import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addContactOrder, getContact } from '@/lib/contacts/store';

export const dynamic = 'force-dynamic';

const statusEnum = z.enum(['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']);

const createSchema = z.object({
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

/** GET /api/contacts/[id]/orders — 返回某客户的全部订单 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const c = await getContact(params.id);
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ orders: c.orders ?? [] });
}

/** POST /api/contacts/[id]/orders — 新建一条订单 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
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
  const updated = await addContactOrder(params.id, parsed.data);
  if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ contact: updated });
}
