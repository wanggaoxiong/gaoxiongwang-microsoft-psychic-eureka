import { NextResponse } from 'next/server';
import { getPersonalStatus } from '@/lib/wa/personal-client';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getPersonalStatus());
}
