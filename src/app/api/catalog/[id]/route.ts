import { NextResponse } from 'next/server';
import { getProduct, deleteProduct } from '@/lib/catalog/repo';

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const product = await getProduct(params.id);
  if (!product) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(product);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const ok = await deleteProduct(params.id);
  return NextResponse.json({ ok });
}
