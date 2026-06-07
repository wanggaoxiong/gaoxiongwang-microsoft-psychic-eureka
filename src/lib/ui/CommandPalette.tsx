'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Result =
  | { kind: 'product'; id: string; title: string; subtitle?: string; image?: string }
  | { kind: 'conversation'; id: string; title: string; subtitle?: string }
  | { kind: 'nav'; id: string; title: string; href: string };

const NAV: Result[] = [
  { kind: 'nav', id: 'nav-catalog', title: '前往 Catalog', href: '/catalog' },
  { kind: 'nav', id: 'nav-inbox', title: '前往 Inbox', href: '/inbox' },
  { kind: 'nav', id: 'nav-sources', title: '前往 Sources', href: '/sources' },
  { kind: 'nav', id: 'nav-pricing', title: '前往 Pricing', href: '/pricing' },
  { kind: 'nav', id: 'nav-settings', title: 'WhatsApp 设置', href: '/settings/whatsapp' }
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<Result[]>([]);
  const [convs, setConvs] = useState<Result[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // global keyboard
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
      setQ('');
      setActive(0);
    }
  }, [open]);

  // search
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const [catRes, convRes] = await Promise.all([
          fetch('/api/catalog?' + new URLSearchParams(q ? { q } : {}).toString()),
          fetch('/api/wa/conversations')
        ]);
        const catJson = await catRes.json();
        const convJson = await convRes.json();
        if (cancelled) return;
        setProducts(
          (catJson.items ?? []).slice(0, 8).map(
            (p: { id: string; title: string; price?: string; mainImage?: string; brand?: string }) => ({
              kind: 'product' as const,
              id: p.id,
              title: p.title,
              subtitle: [p.brand, p.price].filter(Boolean).join(' · '),
              image: p.mainImage
            })
          )
        );
        const ql = q.trim().toLowerCase();
        setConvs(
          (convJson.conversations ?? [])
            .filter(
              (c: { id: string; name?: string; lastMessage?: string }) =>
                !ql ||
                c.id.includes(ql) ||
                c.name?.toLowerCase().includes(ql) ||
                c.lastMessage?.toLowerCase().includes(ql)
            )
            .slice(0, 6)
            .map((c: { id: string; name?: string; lastMessage?: string }) => ({
              kind: 'conversation' as const,
              id: c.id,
              title: c.name || c.id,
              subtitle: c.lastMessage
            }))
        );
        setActive(0);
      } catch {
        // ignore
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  const navResults = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return NAV;
    return NAV.filter((n) => n.title.toLowerCase().includes(ql));
  }, [q]);

  const allResults: Result[] = [...convs, ...products, ...navResults];

  function execute(r: Result) {
    setOpen(false);
    if (r.kind === 'nav') {
      router.push(r.href);
    } else if (r.kind === 'product') {
      router.push(`/catalog?focus=${r.id}`);
    } else if (r.kind === 'conversation') {
      router.push(`/inbox?conv=${r.id}`);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, allResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = allResults[active];
      if (r) execute(r);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-200 px-3 py-2.5">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索商品 / 会话 / 跳转..."
            className="w-full bg-transparent text-sm text-zinc-950 placeholder:text-zinc-400 focus:outline-none"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {allResults.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-zinc-400">没有匹配</p>
          ) : (
            <>
              {convs.length > 0 ? (
                <Group title="会话">
                  {convs.map((r, i) => (
                    <Row
                      key={r.id}
                      result={r}
                      active={allResults.indexOf(r) === active}
                      onClick={() => execute(r)}
                      onHover={() => setActive(allResults.indexOf(r))}
                    />
                  ))}
                </Group>
              ) : null}
              {products.length > 0 ? (
                <Group title="商品">
                  {products.map((r) => (
                    <Row
                      key={r.id}
                      result={r}
                      active={allResults.indexOf(r) === active}
                      onClick={() => execute(r)}
                      onHover={() => setActive(allResults.indexOf(r))}
                    />
                  ))}
                </Group>
              ) : null}
              {navResults.length > 0 ? (
                <Group title="跳转">
                  {navResults.map((r) => (
                    <Row
                      key={r.id}
                      result={r}
                      active={allResults.indexOf(r) === active}
                      onClick={() => execute(r)}
                      onHover={() => setActive(allResults.indexOf(r))}
                    />
                  ))}
                </Group>
              ) : null}
            </>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 text-[10px] text-zinc-400">
          <span>↑↓ 选择 · ⏎ 打开 · Esc 关闭</span>
          <span>⌘K 唤起</span>
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-400">
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({
  result,
  active,
  onClick,
  onHover
}: {
  result: Result;
  active: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
        active ? 'bg-[#5E6AD2]/10' : ''
      }`}
    >
      {result.kind === 'product' && result.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={result.image} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
      ) : (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-zinc-100 text-[10px] text-zinc-500">
          {result.kind === 'nav' ? '↗' : result.kind === 'conversation' ? '💬' : '📦'}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-zinc-950">{result.title}</p>
        {'subtitle' in result && result.subtitle ? (
          <p className="truncate text-[11px] text-zinc-500">{result.subtitle}</p>
        ) : null}
      </div>
    </button>
  );
}
