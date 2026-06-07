import { NextResponse } from 'next/server';
import { getSupplierConnector } from '@/lib/suppliers';
import { searchQuerySchema } from '@/lib/suppliers/base';

export async function POST(request: Request) {
  const body = await request.json();
  const connectorKey = typeof body.connectorKey === 'string' ? body.connectorKey : 'gxhyapp';
  const query = searchQuerySchema.parse(body.query ?? {});
  const connector = getSupplierConnector(connectorKey);
  const session = await connector.login({
    username: process.env.GXHYAPP_USERNAME ?? '',
    password: process.env.GXHYAPP_PASSWORD ?? ''
  });
  const products = await connector.search(query, session);

  return NextResponse.json({ connectorKey, products });
}
