import { NextResponse } from 'next/server';

/**
 * 图片代理：只为绕过浏览器 canvas 跨域问题（拼图需要把图画到 canvas 里）。
 * 仅放行 http/https；超时 10s；最大 8MB。回复加 CORS 头允许 same-origin canvas 读取。
 */
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get('url');
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      return NextResponse.json({ error: `upstream ${r.status}` }, { status: 502 });
    }
    const ct = r.headers.get('content-type') ?? 'image/jpeg';
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'too large' }, { status: 413 });
    }
    return new NextResponse(buf, {
      headers: {
        'content-type': ct,
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*'
      }
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fetch failed' },
      { status: 502 }
    );
  }
}
