'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Card, Input, Textarea } from '@/lib/ui/primitives';

type ContactOrderStatus =
  | 'placed'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

type ContactOrder = {
  id: string;
  orderNo?: string;
  trackingNo?: string;
  carrier?: string;
  items?: string;
  amount?: string;
  currency?: string;
  status: ContactOrderStatus;
  note?: string;
  placedAt?: number;
  shippedAt?: number;
  deliveredAt?: number;
  createdAt: number;
  updatedAt: number;
};

type Contact = {
  id: string;
  phone?: string;
  lid?: string;
  name?: string;
  company?: string;
  position?: string;
  note?: string;
  tags: string[];
  waVerified?: boolean;
  waVerifiedAt?: number;
  totalOrders?: number;
  source?: string;
  orders?: ContactOrder[];
  aiProfile?: {
    summary?: string;
    language?: string;
    preferences?: string[];
    priceBand?: string;
    interests?: string[];
    notes?: string;
    lastSummaryAt?: number;
    basedOnTurns?: number;
  };
  createdAt: number;
  updatedAt: number;
};

type TagStat = { name: string; count: number };

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tags, setTags] = useState<TagStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string>('');
  const [verified, setVerified] = useState<'' | 'yes' | 'no' | 'unknown'>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Contact | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL('/api/contacts', window.location.origin);
      if (q.trim()) url.searchParams.set('q', q.trim());
      if (tag) url.searchParams.set('tag', tag);
      if (verified) url.searchParams.set('verified', verified);
      const r = await fetch(url.toString(), { cache: 'no-store' });
      const j = await r.json();
      setContacts(j.contacts ?? []);
      setTags(j.tags ?? []);
    } finally {
      setLoading(false);
    }
  }, [q, tag, verified]);

  // 标签/验证状态切换立刻请求
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, verified]);

  // 搜索框防抖
  useEffect(() => {
    const t = window.setTimeout(reload, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  const allSelected = contacts.length > 0 && selected.size === contacts.length;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(contacts.map((c) => c.id)));
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doDelete = async (id: string) => {
    if (!confirm('确认删除该联系人？')) return;
    const r = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
    if (r.ok) {
      showToast('已删除');
      setSelected((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      reload();
    } else {
      const j = await r.json().catch(() => ({}));
      alert(`删除失败：${j.error ?? r.statusText}`);
    }
  };

  const doVerifySelected = async () => {
    if (selected.size === 0) {
      showToast('请先勾选要校验的联系人');
      return;
    }
    setVerifying(true);
    try {
      const r = await fetch('/api/contacts/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] })
      });
      const j = await r.json();
      if (!r.ok) {
        alert(`校验失败：${j.error ?? r.statusText}`);
        return;
      }
      const reg = j.results.filter((x: any) => x.registered === true).length;
      const notReg = j.results.filter((x: any) => x.registered === false).length;
      const fail = j.results.filter((x: any) => !x.ok && !x.skipped).length;
      const skip = j.results.filter((x: any) => x.skipped).length;
      showToast(`校验完成：已注册 ${reg} / 未注册 ${notReg} / 跳过 ${skip} / 失败 ${fail}`);
      reload();
    } finally {
      setVerifying(false);
    }
  };

  const stats = useMemo(() => {
    let yes = 0, no = 0, unknown = 0;
    for (const c of contacts) {
      if (c.waVerified === true) yes++;
      else if (c.waVerified === false) no++;
      else unknown++;
    }
    return { total: contacts.length, yes, no, unknown };
  }, [contacts]);

  return (
    <div className="flex h-screen flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-end justify-between gap-4 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-zinc-950">重点客户</h1>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                {stats.total}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              筛出需要重点跟进的客户：基础信息、AI 画像、订单号 / 物流号统统留底，下次回复一查就到。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowImport(true)}>
              <IconUpload className="mr-1.5" />
              导入 CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={doVerifySelected}
              disabled={verifying || selected.size === 0}
              title={selected.size === 0 ? '请先勾选要校验的联系人' : ''}
            >
              {verifying ? <Spinner className="mr-1.5" /> : <IconCheck className="mr-1.5" />}
              批量校验
              {selected.size > 0 ? ` · ${selected.size}` : ''}
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <IconPlus className="mr-1.5" />
              新建联系人
            </Button>
          </div>
        </div>

        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-6 pb-3">
          <SearchBox value={q} onChange={setQ} />
          <FilterChip
            label="按标签筛选"
            value={tag}
            onChange={setTag}
            options={[
              { value: '', label: '全部标签' },
              ...tags.map((t) => ({ value: t.name, label: `${t.name} · ${t.count}` }))
            ]}
          />
          <FilterChip
            label="按 WA 验证状态筛选"
            value={verified}
            onChange={(v) => setVerified(v as any)}
            options={[
              { value: '', label: 'WA 验证：全部' },
              { value: 'yes', label: '已注册' },
              { value: 'no', label: '未注册' },
              { value: 'unknown', label: '未校验' }
            ]}
          />
          <div className="flex-1" />
          <div className="hidden items-center gap-3 text-[11px] text-zinc-500 md:flex">
            <StatPill color="emerald" label="已注册" value={stats.yes} />
            <StatPill color="rose" label="未注册" value={stats.no} />
            <StatPill color="zinc" label="未校验" value={stats.unknown} />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl px-6 py-5">
          {loading && contacts.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-zinc-400">
              <Spinner className="mr-2" /> 加载中…
            </div>
          ) : contacts.length === 0 ? (
            <EmptyState onCreate={() => setShowCreate(true)} onImport={() => setShowImport(true)} />
          ) : (
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-zinc-200 bg-zinc-50/60 text-left text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="w-10 px-4 py-2.5">
                        <input
                          aria-label="全选"
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          className="h-3.5 w-3.5 cursor-pointer rounded border-zinc-300 accent-zinc-900"
                        />
                      </th>
                      <th className="px-3 py-2.5">联系人</th>
                      <th className="px-3 py-2.5">WhatsApp 标识</th>
                      <th className="px-3 py-2.5">标签</th>
                      <th className="px-3 py-2.5">WA 验证</th>
                      <th className="px-3 py-2.5">备注</th>
                      <th className="w-28 px-3 py-2.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((c) => (
                      <ContactRow
                        key={c.id}
                        contact={c}
                        selected={selected.has(c.id)}
                        onToggle={() => toggleOne(c.id)}
                        onEdit={() => setEditing(c)}
                        onDelete={() => doDelete(c.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {selected.size > 0 ? (
                <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50/60 px-4 py-2 text-xs text-zinc-600">
                  <span>
                    已选 {selected.size} / {contacts.length}
                  </span>
                  <button
                    type="button"
                    className="text-zinc-500 hover:text-zinc-900"
                    onClick={() => setSelected(new Set())}
                  >
                    清除选择
                  </button>
                </div>
              ) : null}
            </Card>
          )}
        </div>
      </div>

      {toast ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      ) : null}

      {showCreate ? (
        <ContactEditor
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            reload();
            showToast('已创建');
          }}
        />
      ) : null}

      {editing ? (
        <ContactEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
            showToast('已保存');
          }}
        />
      ) : null}

      {showImport ? (
        <ImportModal
          onClose={() => setShowImport(false)}
          onDone={(stats) => {
            setShowImport(false);
            reload();
            showToast(
              `导入完成：新增 ${stats.created} / 合并 ${stats.merged} / 跳过 ${stats.skipped}`
            );
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------- 表格行 ---------------- */

function ContactRow({
  contact: c,
  selected,
  onToggle,
  onEdit,
  onDelete
}: {
  contact: Contact;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const display = c.name || c.phone || c.lid || '(未命名)';
  const chatHref = `/inbox?conversation=${encodeURIComponent(c.lid ?? `${c.phone}@c.us`)}`;
  return (
    <tr
      className={`border-b border-zinc-100 transition-colors last:border-b-0 ${
        selected ? 'bg-indigo-50/40' : 'hover:bg-zinc-50'
      }`}
    >
      <td className="px-4 py-3 align-middle">
        <input
          aria-label={`选择 ${display}`}
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="h-3.5 w-3.5 cursor-pointer rounded border-zinc-300 accent-zinc-900"
        />
      </td>
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center gap-3">
          <Avatar name={display} />
          <div className="min-w-0">
            <div className="truncate font-medium text-zinc-900">{c.name || '(未命名)'}</div>
            {c.company || c.position ? (
              <div className="truncate text-xs text-zinc-500">
                {c.company}
                {c.company && c.position ? ' · ' : ''}
                {c.position}
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-3 py-3 align-middle">
        {c.phone ? (
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-100">
              Phone
            </span>
            <span className="font-mono text-xs text-zinc-700">+{c.phone}</span>
          </div>
        ) : null}
        {c.lid ? (
          <div className={`flex items-center gap-1.5 ${c.phone ? 'mt-1' : ''}`}>
            <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-100">
              LID
            </span>
            <span className="truncate font-mono text-[11px] text-zinc-500" title={c.lid}>
              {c.lid}
            </span>
          </div>
        ) : null}
        {!c.phone && !c.lid ? <span className="text-xs text-zinc-400">—</span> : null}
      </td>
      <td className="px-3 py-3 align-middle">
        <div className="flex flex-wrap gap-1">
          {c.tags.length === 0 ? (
            <span className="text-xs text-zinc-300">—</span>
          ) : (
            c.tags.map((t) => (
              <span key={t} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700">
                {t}
              </span>
            ))
          )}
        </div>
      </td>
      <td className="px-3 py-3 align-middle">
        {c.waVerified === true ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 已注册
          </span>
        ) : c.waVerified === false ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-600">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> 未注册
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" /> 未校验
          </span>
        )}
      </td>
      <td className="px-3 py-3 align-middle">
        <div className="flex flex-col gap-1">
          {c.orders?.length ? (
            <span className="inline-flex w-fit items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 ring-1 ring-indigo-100">
              📦 {c.orders.length} 单
            </span>
          ) : null}
          {c.aiProfile?.summary ? (
            <span
              className="line-clamp-2 max-w-[20rem] text-[11px] text-indigo-600/80"
              title={c.aiProfile.summary}
            >
              🤖 {c.aiProfile.summary}
            </span>
          ) : null}
          {c.note ? (
            <div className="line-clamp-2 max-w-[20rem] text-xs text-zinc-600">{c.note}</div>
          ) : null}
          {!c.orders?.length && !c.aiProfile?.summary && !c.note ? (
            <span className="text-xs text-zinc-300">—</span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center justify-end gap-1">
          {c.phone || c.lid ? (
            <Link
              href={chatHref}
              title="发起 WhatsApp 聊天"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <IconChat />
            </Link>
          ) : null}
          <button
            type="button"
            title="编辑"
            onClick={onEdit}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <IconPencil />
          </button>
          <button
            type="button"
            title="删除"
            onClick={onDelete}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-rose-50 hover:text-rose-600"
          >
            <IconTrash />
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ---------------- 编辑器 ---------------- */

function ContactEditor({
  initial,
  onClose,
  onSaved
}: {
  initial?: Contact;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [lid, setLid] = useState(initial?.lid ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [company, setCompany] = useState(initial?.company ?? '');
  const [position, setPosition] = useState(initial?.position ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [tagsInput, setTagsInput] = useState((initial?.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!phone.trim() && !lid.trim()) {
      setErr('phone 或 lid 至少需要一个');
      return;
    }
    setSaving(true);
    const body = {
      phone: phone.trim() || undefined,
      lid: lid.trim() || undefined,
      name: name.trim() || undefined,
      company: company.trim() || undefined,
      position: position.trim() || undefined,
      note: note.trim() || undefined,
      tags: tagsInput
        .split(/[,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean)
    };
    try {
      const url = isEdit ? `/api/contacts/${initial!.id}` : '/api/contacts';
      const method = isEdit ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error ?? r.statusText);
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold">{isEdit ? '编辑客户' : '新建客户'}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900">
            ✕
          </button>
        </header>
        <div className="grid grid-cols-2 gap-3 overflow-y-auto px-5 py-4">
          <Field label="姓名">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="公司">
            <Input value={company} onChange={(e) => setCompany(e.target.value)} />
          </Field>
          <Field label="电话（E.164 不带 +）">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="例：8613800000000"
              className="font-mono"
            />
          </Field>
          <Field label="LID（可选）">
            <Input
              value={lid}
              onChange={(e) => setLid(e.target.value)}
              placeholder="例：123456@lid"
              className="font-mono"
            />
          </Field>
          <Field label="职位">
            <Input value={position} onChange={(e) => setPosition(e.target.value)} />
          </Field>
          <Field label="标签（逗号分隔）">
            <Input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="鞋类, 美国客户"
            />
          </Field>
          <div className="col-span-2">
            <Field label="备注">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
            </Field>
          </div>
          {isEdit && initial!.aiProfile ? (
            <div className="col-span-2 mt-2 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-indigo-900">AI 客户画像</h3>
                <span className="text-[10px] text-indigo-600/70">
                  {initial!.aiProfile.lastSummaryAt
                    ? `更新于 ${fmtOrderTime(initial!.aiProfile.lastSummaryAt)}`
                    : ''}
                  {initial!.aiProfile.basedOnTurns
                    ? ` · 基于 ${initial!.aiProfile.basedOnTurns} 条聊天`
                    : ''}
                </span>
              </div>
              {initial!.aiProfile.summary ? (
                <p className="text-xs leading-relaxed text-zinc-700">
                  {initial!.aiProfile.summary}
                </p>
              ) : null}
              {initial!.aiProfile.preferences?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {initial!.aiProfile.preferences.map((p, i) => (
                    <span
                      key={i}
                      className="rounded bg-white px-1.5 py-0.5 text-[11px] text-indigo-700 ring-1 ring-indigo-200"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-zinc-600">
                {initial!.aiProfile.language ? (
                  <span>语言：{initial!.aiProfile.language}</span>
                ) : null}
                {initial!.aiProfile.priceBand ? (
                  <span>价位：{initial!.aiProfile.priceBand}</span>
                ) : null}
                {initial!.aiProfile.interests?.length ? (
                  <span>兴趣：{initial!.aiProfile.interests.join(' / ')}</span>
                ) : null}
              </div>
              {initial!.aiProfile.notes ? (
                <p className="mt-1 text-[11px] italic text-zinc-500">
                  📝 {initial!.aiProfile.notes}
                </p>
              ) : null}
            </div>
          ) : null}
          {isEdit ? (
            <div className="col-span-2 mt-2 border-t border-zinc-200 pt-4">
              <OrdersSection contactId={initial!.id} initialOrders={initial!.orders ?? []} />
            </div>
          ) : null}
          {err ? <div className="col-span-2 text-xs text-rose-600">{err}</div> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/40 px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? '保存中…' : isEdit ? '保存' : '创建'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

/* ---------------- 订单跟踪 ---------------- */

const ORDER_STATUS_LABEL: Record<ContactOrderStatus, string> = {
  placed: '已下单',
  paid: '已付款',
  shipped: '已发货',
  delivered: '已送达',
  cancelled: '已取消',
  refunded: '已退款'
};

const ORDER_STATUS_TONE: Record<ContactOrderStatus, string> = {
  placed: 'bg-zinc-100 text-zinc-700',
  paid: 'bg-blue-50 text-blue-700',
  shipped: 'bg-amber-50 text-amber-700',
  delivered: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-zinc-100 text-zinc-500 line-through',
  refunded: 'bg-rose-50 text-rose-700'
};

/** 常用币种 + 符号。键是 ISO 4217 代码，值是展示前缀符号。 */
const CURRENCIES: Array<{ code: string; symbol: string; label: string }> = [
  { code: 'CNY', symbol: '¥', label: 'CNY 人民币' },
  { code: 'USD', symbol: '$', label: 'USD 美元' },
  { code: 'EUR', symbol: '€', label: 'EUR 欧元' },
  { code: 'GBP', symbol: '£', label: 'GBP 英镑' },
  { code: 'JPY', symbol: '¥', label: 'JPY 日元' },
  { code: 'HKD', symbol: 'HK$', label: 'HKD 港币' },
  { code: 'AUD', symbol: 'A$', label: 'AUD 澳元' },
  { code: 'CAD', symbol: 'C$', label: 'CAD 加元' },
  { code: 'SGD', symbol: 'S$', label: 'SGD 新元' }
];

function currencySymbol(code?: string): string {
  if (!code) return '';
  const c = CURRENCIES.find((x) => x.code === code.toUpperCase());
  return c?.symbol ?? code.toUpperCase();
}

function fmtAmount(amount?: string, currency?: string): string {
  if (!amount && !currency) return '';
  if (!amount) return currency ?? '';
  const sym = currencySymbol(currency);
  return sym ? `${sym}${amount}` : amount;
}

function fmtOrderTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 把 yyyy-mm-dd 转成当天 0 点的毫秒；空串返回 undefined。 */
function dateInputToMs(s: string): number | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d).getTime();
}

/** 把毫秒转成 yyyy-mm-dd（本地时区），方便填回 input[type=date]。 */
function msToDateInput(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayInput(): string {
  return msToDateInput(Date.now());
}

function OrdersSection({
  contactId,
  initialOrders
}: {
  contactId: string;
  initialOrders: ContactOrder[];
}) {
  const [orders, setOrders] = useState<ContactOrder[]>(initialOrders);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = async () => {
    const r = await fetch(`/api/contacts/${contactId}/orders`);
    if (r.ok) {
      const j = (await r.json()) as { orders: ContactOrder[] };
      setOrders(j.orders ?? []);
    }
  };

  const remove = async (orderId: string) => {
    if (!confirm('确定删除这条订单记录？')) return;
    const r = await fetch(`/api/contacts/${contactId}/orders/${orderId}`, { method: 'DELETE' });
    if (r.ok) refresh();
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">订单跟踪</h3>
          <p className="text-[11px] text-zinc-500">登记订单号、物流单号，方便后续回复客户查单。</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
          {adding ? '取消' : '+ 添加订单'}
        </Button>
      </div>

      {adding ? (
        <OrderForm
          contactId={contactId}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : null}

      {orders.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-400">
          暂无订单记录
        </div>
      ) : (
        <ul className="space-y-2">
          {orders.map((o) =>
            editingId === o.id ? (
              <li key={o.id}>
                <OrderForm
                  contactId={contactId}
                  initial={o}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null);
                    refresh();
                  }}
                />
              </li>
            ) : (
              <li
                key={o.id}
                className="rounded-md border border-zinc-200 bg-zinc-50/50 px-3 py-2 text-xs"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ORDER_STATUS_TONE[o.status]}`}
                  >
                    {ORDER_STATUS_LABEL[o.status]}
                  </span>
                  {o.orderNo ? (
                    <span className="font-mono text-zinc-800">#{o.orderNo}</span>
                  ) : (
                    <span className="text-zinc-400">无订单号</span>
                  )}
                  {o.amount || o.currency ? (
                    <span className="text-zinc-700">· {fmtAmount(o.amount, o.currency)}</span>
                  ) : null}
                  <span className="ml-auto text-[10px] text-zinc-400">
                    下单 {fmtOrderTime(o.placedAt ?? o.createdAt)}
                  </span>
                </div>
                {o.items ? <div className="text-zinc-700">{o.items}</div> : null}
                {o.trackingNo || o.carrier ? (
                  <div className="mt-1 text-zinc-600">
                    🚚 {o.carrier ? `${o.carrier} · ` : ''}
                    {o.trackingNo ? (
                      <span className="font-mono">{o.trackingNo}</span>
                    ) : (
                      <span className="text-zinc-400">未填物流号</span>
                    )}
                    {o.shippedAt ? (
                      <span className="ml-2 text-[10px] text-zinc-400">
                        发货 {fmtOrderTime(o.shippedAt)}
                      </span>
                    ) : null}
                    {o.deliveredAt ? (
                      <span className="ml-2 text-[10px] text-zinc-400">
                        送达 {fmtOrderTime(o.deliveredAt)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {o.note ? <div className="mt-1 text-zinc-500">📝 {o.note}</div> : null}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    className="text-[11px] text-zinc-500 hover:text-zinc-800"
                    onClick={() => setEditingId(o.id)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="text-[11px] text-rose-500 hover:text-rose-700"
                    onClick={() => remove(o.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            )
          )}
        </ul>
      )}
    </div>
  );
}

function OrderForm({
  contactId,
  initial,
  onCancel,
  onSaved
}: {
  contactId: string;
  initial?: ContactOrder;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [orderNo, setOrderNo] = useState(initial?.orderNo ?? '');
  const [trackingNo, setTrackingNo] = useState(initial?.trackingNo ?? '');
  const [carrier, setCarrier] = useState(initial?.carrier ?? '');
  const [items, setItems] = useState(initial?.items ?? '');
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [currency, setCurrency] = useState(initial?.currency ?? 'CNY');
  const [status, setStatus] = useState<ContactOrderStatus>(initial?.status ?? 'placed');
  const [orderNote, setOrderNote] = useState(initial?.note ?? '');
  const [placedAt, setPlacedAt] = useState(
    initial ? msToDateInput(initial.placedAt ?? initial.createdAt) : todayInput()
  );
  const [shippedAt, setShippedAt] = useState(msToDateInput(initial?.shippedAt));
  const [deliveredAt, setDeliveredAt] = useState(msToDateInput(initial?.deliveredAt));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setSaving(true);
    try {
      const body = {
        orderNo: orderNo.trim() || undefined,
        trackingNo: trackingNo.trim() || undefined,
        carrier: carrier.trim() || undefined,
        items: items.trim() || undefined,
        amount: amount.trim() || undefined,
        currency: amount.trim() ? currency : undefined,
        status,
        note: orderNote.trim() || undefined,
        placedAt: dateInputToMs(placedAt),
        shippedAt: dateInputToMs(shippedAt),
        deliveredAt: dateInputToMs(deliveredAt)
      };
      const url = initial
        ? `/api/contacts/${contactId}/orders/${initial.id}`
        : `/api/contacts/${contactId}/orders`;
      const r = await fetch(url, {
        method: initial ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error ?? r.statusText);
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="订单号">
          <Input
            value={orderNo}
            onChange={(e) => setOrderNo(e.target.value)}
            placeholder="例：A20260523-001"
            className="font-mono"
          />
        </Field>
        <Field label="状态">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ContactOrderStatus)}
            title="订单状态"
            className="h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {(Object.keys(ORDER_STATUS_LABEL) as ContactOrderStatus[]).map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="金额">
          <div className="flex gap-1.5">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="flex-1 font-mono"
            />
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              title="币种"
              className="h-9 w-24 shrink-0 rounded-md border border-zinc-300 bg-white px-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.symbol} {c.code}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <Field label="商品摘要">
          <Input
            value={items}
            onChange={(e) => setItems(e.target.value)}
            placeholder="白色运动鞋 42 码 × 2"
          />
        </Field>
        <Field label="物流商">
          <Input
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            placeholder="DHL / 顺丰 / 中通"
          />
        </Field>
        <Field label="物流单号">
          <Input
            value={trackingNo}
            onChange={(e) => setTrackingNo(e.target.value)}
            placeholder="例：SF1234567890"
            className="font-mono"
          />
        </Field>
        <Field label="下单日期">
          <Input
            type="date"
            value={placedAt}
            onChange={(e) => setPlacedAt(e.target.value)}
          />
        </Field>
        <Field label="发货日期">
          <Input
            type="date"
            value={shippedAt}
            onChange={(e) => setShippedAt(e.target.value)}
          />
        </Field>
        <Field label="送达日期">
          <Input
            type="date"
            value={deliveredAt}
            onChange={(e) => setDeliveredAt(e.target.value)}
          />
        </Field>
        <div className="col-span-2">
          <Field label="备注">
            <Textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.target.value)}
              rows={2}
              placeholder="例如：客户要求加急发货"
            />
          </Field>
        </div>
      </div>
      {err ? <div className="mt-2 text-xs text-rose-600">{err}</div> : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? '保存中…' : initial ? '保存订单' : '添加订单'}
        </Button>
      </div>
    </div>
  );
}

/* ---------------- 导入 ---------------- */

function ImportModal({
  onClose,
  onDone
}: {
  onClose: () => void;
  onDone: (stats: { created: number; merged: number; skipped: number }) => void;
}) {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!csv.trim()) {
      setErr('请先粘贴 CSV 内容或选择文件');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv })
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error ?? r.statusText);
        return;
      }
      onDone(j);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    setCsv(txt);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold">导入 CSV</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900">
            ✕
          </button>
        </header>
        <div className="px-5 py-4">
          <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 text-xs text-zinc-600">
            <div className="mb-1 font-medium text-zinc-700">支持的列名（任选）</div>
            <div className="font-mono text-[11px] leading-relaxed text-zinc-500">
              name / 姓名 ｜ phone / 手机 / 电话 ｜ lid ｜ company / 公司 ｜ position / 职位 ｜ note / 备注 ｜ tags / 标签
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">
              tags 多值用 <code>,</code>/<code>;</code>/<code>|</code> 分隔；phone 只保留数字（不要 +）。
            </div>
          </div>
          <input
            aria-label="选择 CSV 文件"
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={onFile}
            className="mb-2 block text-xs"
          />
          <Textarea
            rows={12}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={'name,phone,tags\nAlice,8613800000000,"鞋类,美国"\nBob,12025550100,'}
            className="font-mono text-xs"
          />
          {err ? <div className="mt-2 text-xs text-rose-600">{err}</div> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/40 px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? '导入中…' : '导入'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

/* ---------------- 小组件 ---------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-zinc-600">{label}</span>
      {children}
    </label>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
      <input
        aria-label="搜索"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="搜索 姓名 / 电话 / 公司 / 标签 / 备注"
        className="h-8 w-80 rounded-md border border-zinc-300 bg-white pl-8 pr-2 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-100"
      />
    </div>
  );
}

function FilterChip({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-100"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function StatPill({
  color,
  label,
  value
}: {
  color: 'emerald' | 'rose' | 'zinc';
  label: string;
  value: number;
}) {
  const dot =
    color === 'emerald' ? 'bg-emerald-500' : color === 'rose' ? 'bg-rose-500' : 'bg-zinc-300';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label} {value}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const letter = (name || '?').trim().charAt(0).toUpperCase();
  const colors = [
    'bg-indigo-100 text-indigo-700',
    'bg-emerald-100 text-emerald-700',
    'bg-amber-100 text-amber-700',
    'bg-rose-100 text-rose-700',
    'bg-sky-100 text-sky-700',
    'bg-violet-100 text-violet-700',
    'bg-teal-100 text-teal-700'
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const cls = colors[h % colors.length];
  return (
    <div
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${cls}`}
    >
      {letter}
    </div>
  );
}

function EmptyState({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <circle cx="12" cy="11" r="2.5" />
          <path d="M8 17c1-2 2.5-3 4-3s3 1 4 3" />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-zinc-900">还没有联系人</h2>
      <p className="mt-1 max-w-sm text-sm text-zinc-500">
        手动录入、批量导入手机通讯录，或者在「收件箱」里用 AI 从聊天记录里自动识别加入。
      </p>
      <div className="mt-5 flex gap-2">
        <Button variant="ghost" onClick={onImport}>
          导入 CSV
        </Button>
        <Button onClick={onCreate}>+ 新建联系人</Button>
      </div>
    </div>
  );
}

function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700 ${className}`}
    />
  );
}

/* ---------------- 图标 ---------------- */

function IconPlus({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconUpload({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 8l5-5 5 5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function IconCheck({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12l2 2 4-4" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function IconSearch({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </svg>
  );
}
