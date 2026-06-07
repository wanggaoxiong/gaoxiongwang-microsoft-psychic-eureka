'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { mockSupplierSources } from '@/mocks/supplierCatalog';
import { Badge, Button, Card } from '@/lib/ui/primitives';
import { AddProductModal } from '@/app/catalog/AddProductModal';

type Counts = { total: number; pending: number };

export default function SourcesPage() {
  const [showAdd, setShowAdd] = useState(false);
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const [scanning, setScanning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function refreshCounts() {
    const entries = await Promise.all(
      mockSupplierSources.map(async (s) => {
        try {
          const r = await fetch(`/api/sources/${s.id}/discoveries`, { cache: 'no-store' });
          const j = await r.json();
          return [s.id, j.counts as Counts] as const;
        } catch {
          return [s.id, { total: 0, pending: 0 }] as const;
        }
      })
    );
    setCounts(Object.fromEntries(entries));
  }

  useEffect(() => {
    refreshCounts();
  }, []);

  async function scanSource(id: string) {
    setScanning(id);
    setToast(null);
    try {
      const r = await fetch(`/api/sources/${id}/discover`, { method: 'POST' });
      const j = await r.json();
      if (j.ok) setToast(`${id} 扫描完成：新增 ${j.added} / 共 ${j.scanned}`);
      else setToast(`${id} 扫描失败：${j.error ?? '未知错误'}`);
      await refreshCounts();
    } catch (e: any) {
      setToast(`扫描异常：${e?.message ?? e}`);
    } finally {
      setScanning(null);
    }
  }

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-8 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-zinc-950">Sources</h1>
            <p className="text-xs text-zinc-500">
              接入货源 → 抓取详情 + 主图链接 → 自动入库到 Catalog
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/catalog">
              <Button variant="ghost" size="md">
                查看 Catalog →
              </Button>
            </Link>
            <Button
              variant="primary"
              size="md"
              leading={<span>+</span>}
              onClick={() => setShowAdd(true)}
            >
              抓取商品
            </Button>
          </div>
        </div>
        {toast ? (
          <div className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
            {toast}
          </div>
        ) : null}
      </div>

      <div className="space-y-6 px-8 py-6">
        {/* connector 列表 */}
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            已接入货源
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {mockSupplierSources.map((s) => (
              <Card key={s.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-950">{s.name}</p>
                    <a
                      href={s.websiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-xs text-[#5E6AD2] hover:underline"
                    >
                      {s.websiteUrl}
                    </a>
                  </div>
                  <Badge tone="success">{s.connectionStatus}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <Badge tone="muted">{s.sourceType}</Badge>
                  <Badge tone="muted">{s.ingestionMode}</Badge>
                  <Badge tone="muted">商品 {s.productCount.toLocaleString('zh-CN')}</Badge>
                  <Badge tone="muted">商家 {s.merchantCount.toLocaleString('zh-CN')}</Badge>
                  {counts[s.id]?.total ? (
                    <Badge tone="accent">
                      发现池 {counts[s.id].pending}/{counts[s.id].total}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-[11px] text-zinc-400">
                    最后同步：{s.lastSyncedAt}
                  </p>
                  <div className="flex items-center gap-2">
                    <Link href={`/sources/${s.id}/discoveries`}>
                      <Button size="sm" variant="ghost">
                        发现池
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => scanSource(s.id)}
                      disabled={scanning === s.id}
                    >
                      {scanning === s.id ? '扫描中…' : '扫描'}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => setShowAdd(true)}
                    >
                      从此源抓取
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>

        {/* 抓取流程说明 */}
        <Card className="p-5">
          <h2 className="text-sm font-medium text-zinc-950">抓取流程</h2>
          <ol className="mt-3 space-y-2 text-xs text-zinc-600">
            <li className="flex gap-2">
              <span className="font-mono text-zinc-400">1.</span>
              <span>
                粘贴货源详情页 URL 或商品 code（如{' '}
                <code className="rounded bg-zinc-100 px-1 py-0.5">1190184416</code>）
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-zinc-400">2.</span>
              <span>
                Playwright 渲染 SPA 拿到完整 HTML +
                主图链接（SPA 动态数据走 LLM 视觉识别归一化）
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-zinc-400">3.</span>
              <span>结果自动 upsert 到 Catalog（按 source+code 去重）</span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-zinc-400">4.</span>
              <span>
                在 Catalog 浏览管理，或从 Inbox 中一键发到 WhatsApp 会话
              </span>
            </li>
          </ol>
        </Card>
      </div>

      <AddProductModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          // 入库成功，保留 modal 让用户连续抓多个；关闭时再回到列表
        }}
      />
    </div>
  );
}
