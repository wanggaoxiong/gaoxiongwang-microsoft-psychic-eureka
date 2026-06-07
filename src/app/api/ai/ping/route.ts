import { NextResponse } from 'next/server';
import { z } from 'zod';
import axios from 'axios';
import { httpsAgentWithCustomDns } from '@/lib/net/dns-agent';

const schema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1)
});

function normalizeEndpoint(raw: string): string {
  let s = raw.trim();
  try {
    const url = new URL(s);
    s = `${url.origin}${url.pathname}`;
  } catch {
    /* leave */
  }
  return s
    .replace(/\/+$/, '')
    .replace(/\/openai\/responses$/i, '')
    .replace(/\/openai\/v1\/responses$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 }
    );
  }

  const { endpoint, apiKey, model } = parsed.data;
  const url = `${normalizeEndpoint(endpoint)}/openai/v1/responses`;
  const start = Date.now();

  try {
    const r = await axios.post(
      url,
      {
        model,
        max_output_tokens: 32,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'ping. reply with exactly: pong' }]
          }
        ]
      },
      {
        timeout: 20_000,
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        validateStatus: (s) => s >= 200 && s < 500,
        httpsAgent: httpsAgentWithCustomDns
      }
    );

    const elapsedMs = Date.now() - start;

    if (r.status >= 400 || r.data?.error) {
      return NextResponse.json({
        ok: false,
        elapsedMs,
        status: r.status,
        reason: r.data?.error?.message ?? `HTTP ${r.status}`
      });
    }

    // 提取文字（responses API 形状）
    let text = '';
    if (typeof r.data?.output_text === 'string') text = r.data.output_text;
    else if (Array.isArray(r.data?.output)) {
      for (const item of r.data.output) {
        if (Array.isArray(item?.content)) {
          for (const p of item.content) {
            if (typeof p?.text === 'string') text += p.text;
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      elapsedMs,
      status: r.status,
      modelEcho: r.data?.model ?? model,
      sample: text.slice(0, 80)
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      elapsedMs: Date.now() - start,
      reason: e instanceof Error ? e.message : String(e)
    });
  }
}
