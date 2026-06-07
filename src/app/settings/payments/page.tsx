'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Textarea, Label, Card, Badge, Divider } from '@/lib/ui/primitives';

type PaymentMethod = {
  id: string;
  label: string;
  enabled: boolean;
  detail?: string;
  note?: string;
};

function newId() {
  return `pm-${Math.random().toString(36).slice(2, 8)}`;
}

export default function PaymentSettingsPage() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/payments/methods')
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && Array.isArray(j.config?.methods)) setMethods(j.config.methods);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  function update(id: string, patch: Partial<PaymentMethod>) {
    setMethods((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function remove(id: string) {
    setMethods((prev) => prev.filter((m) => m.id !== id));
  }

  function add() {
    setMethods((prev) => [...prev, { id: newId(), label: '', enabled: true }]);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const clean = methods
        .map((m) => ({ ...m, label: m.label.trim() }))
        .filter((m) => m.label.length > 0);
      const r = await fetch('/api/payments/methods', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ methods: clean })
      });
      const j = await r.json();
      if (!j?.ok) {
        setError(j?.error || `HTTP ${r.status}`);
        return;
      }
      setMethods(j.config.methods);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-8 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-zinc-950">收款方式</h1>
            <p className="text-xs text-zinc-500">
              配置可用的收款方式名称，供 AI 在付款环节自然地告知客户支持哪些方式。
            </p>
          </div>
          <Badge tone={!loaded ? 'muted' : methods.some((m) => m.enabled) ? 'success' : 'warning'}>
            {!loaded ? '加载中' : `${methods.filter((m) => m.enabled).length} 个启用`}
          </Badge>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-6 px-8 py-6">
        <Card className="p-5">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800">
            <p className="font-medium">⚠️ 安全说明</p>
            <p className="mt-1">
              AI 只会用「方式名称」告诉客户支持哪些收款方式（如 PayPal、银行转账），
              <strong>绝不会自动发出真实账号/收款详情</strong>。客户进入付款环节时，系统会
              <strong>自动暂停 AI 并在左侧亮灯</strong>，由人工核对后亲自发送账号、出 PI 收款。
              下方「真实账号/详情」与「备注」仅供人工查看与一键复制，不会进入 AI。
            </p>
          </div>

          <Divider className="my-4" />

          <div className="space-y-4">
            {methods.length === 0 && loaded ? (
              <p className="text-sm text-zinc-500">还没有收款方式，点下方「+ 添加方式」新增。</p>
            ) : null}
            {methods.map((m) => (
              <div
                key={m.id}
                className={`rounded-lg border p-4 ${
                  m.enabled ? 'border-zinc-200 bg-white' : 'border-zinc-200 bg-zinc-50/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      onChange={(e) => update(m.id, { enabled: e.target.checked })}
                      className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-[11px] text-zinc-500">{m.enabled ? '启用' : '停用'}</span>
                  </label>
                  <Input
                    value={m.label}
                    onChange={(e) => update(m.id, { label: e.target.value })}
                    placeholder="方式名称（如 PayPal / 银行转账 / Wise）— 这个会给 AI 看"
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => remove(m.id)}
                    className="rounded-md px-2 py-1 text-[12px] text-rose-600 hover:bg-rose-50"
                  >
                    删除
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <Label className="text-[11px] text-zinc-500">
                      真实账号 / 收款详情（仅人工可见，不进 AI）
                    </Label>
                    <Textarea
                      value={m.detail ?? ''}
                      onChange={(e) => update(m.id, { detail: e.target.value })}
                      placeholder="如 PayPal 邮箱、银行卡号、SWIFT… 仅人工复制使用"
                      rows={2}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-zinc-500">备注（仅人工可见）</Label>
                    <Textarea
                      value={m.note ?? ''}
                      onChange={(e) => update(m.id, { note: e.target.value })}
                      placeholder="如手续费、到账时间提醒…"
                      rows={2}
                      className="mt-1"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <Button variant="secondary" onClick={add}>
              + 添加方式
            </Button>
            <div className="flex items-center gap-3">
              {savedAt ? (
                <span className="text-[12px] text-emerald-600">已保存</span>
              ) : null}
              {error ? <span className="text-[12px] text-rose-600">{error}</span> : null}
              <Button variant="primary" onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
