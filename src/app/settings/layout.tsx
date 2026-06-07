'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const NAV: Array<{ href: string; label: string; desc: string }> = [
  { href: '/settings/ai', label: 'AI 模型', desc: '配置抓取归一化所用的 LLM' },
  { href: '/settings/payments', label: '收款方式', desc: '付款环节可告知客户的方式' },
  { href: '/settings/whatsapp', label: 'WhatsApp', desc: '个人号 / Cloud API 接入' }
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() || '';
  return (
    <div className="flex h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-zinc-200 bg-zinc-50/60 md:block">
        <div className="px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">设置</p>
        </div>
        <nav className="space-y-0.5 px-2">
          {NAV.map((it) => {
            const active = pathname.startsWith(it.href);
            return (
              <Link
                key={it.href}
                href={it.href}
                className={`block rounded-md px-3 py-2 transition-colors ${
                  active
                    ? 'bg-white text-zinc-950 shadow-sm ring-1 ring-zinc-200'
                    : 'text-zinc-600 hover:bg-white hover:text-zinc-900'
                }`}
              >
                <p className="text-sm font-medium">{it.label}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">{it.desc}</p>
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
