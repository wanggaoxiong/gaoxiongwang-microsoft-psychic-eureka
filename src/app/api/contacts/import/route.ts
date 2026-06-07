import { NextResponse } from 'next/server';
import { z } from 'zod';
import { importContacts, type ContactInput } from '@/lib/contacts/store';
import { mapCsvRow, parseCsv } from '@/lib/contacts/csv';

export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z.object({
    csv: z.string().min(1)
  }),
  z.object({
    rows: z
      .array(
        z.object({
          phone: z.string().optional(),
          lid: z.string().optional(),
          name: z.string().optional(),
          company: z.string().optional(),
          position: z.string().optional(),
          note: z.string().optional(),
          tags: z.array(z.string()).optional()
        })
      )
      .min(1)
      .max(5000)
  })
]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  let rows: ContactInput[];
  if ('csv' in parsed.data) {
    const raw = parseCsv(parsed.data.csv);
    rows = raw.map(mapCsvRow);
  } else {
    rows = parsed.data.rows;
  }
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, created: 0, merged: 0, skipped: 0, total: 0 });
  }
  const stats = await importContacts(rows);
  return NextResponse.json({ ok: true, ...stats });
}
