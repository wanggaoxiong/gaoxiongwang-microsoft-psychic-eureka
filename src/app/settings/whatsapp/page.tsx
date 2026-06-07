'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input, Label, Card, Badge, Divider } from '@/lib/ui/primitives';
import {
  loadWaConfig,
  saveWaConfig,
  clearWaConfig,
  isWaConfigured,
  type WaConfig
} from '@/lib/wa/config';

type WaMode = 'personal' | 'cloud';
const MODE_KEY = 'wa_mode_v1';

export default function WhatsAppSettingsPage() {
  const [mode, setMode] = useState<WaMode>('personal');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(MODE_KEY) as WaMode | null;
    if (stored === 'personal' || stored === 'cloud') setMode(stored);
  }, []);

  function changeMode(m: WaMode) {
    setMode(m);
    if (typeof window !== 'undefined') window.localStorage.setItem(MODE_KEY, m);
  }

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-8 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-zinc-950">WhatsApp 配置</h1>
            <p className="text-xs text-zinc-500">选择账号类型：个人号扫码登录，或商业号 Cloud API</p>
          </div>
        </div>
        <div className="mt-3 flex gap-1">
          <TabBtn active={mode === 'personal'} onClick={() => changeMode('personal')}>
            个人号 (QR 登录)
          </TabBtn>
          <TabBtn active={mode === 'cloud'} onClick={() => changeMode('cloud')}>
            商业号 (Cloud API)
          </TabBtn>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-6 px-8 py-6">
        {mode === 'personal' ? <PersonalPanel /> : <CloudPanel />}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
        active
          ? 'bg-zinc-100 text-zinc-950'
          : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

// ===================== Personal (whatsapp-web.js) =====================

type PersonalStatus = {
  state:
    | 'idle'
    | 'initializing'
    | 'qr'
    | 'authenticated'
    | 'ready'
    | 'auth_failure'
    | 'disconnected';
  qr: string | null;
  me: { id: string; name?: string } | null;
  lastError: string | null;
  startedAt?: number | null;
  session?: {
    profileId: string;
    hasSession: boolean;
    invalid?: boolean;
    dir: string;
  };
  proxy?: {
    configured: boolean;
    configuredServer: string | null;
    inUse: string | null;
    explicitlyDisabled: boolean;
  };
};

const USE_PROXY_KEY = 'wa_personal_use_proxy_v1';

type ProfileInfo = {
  id: string;
  label: string;
  lastActivatedAt?: number;
  createdAt: number;
};

function PersonalPanel() {
  const [status, setStatus] = useState<PersonalStatus | null>(null);
  const [starting, setStarting] = useState(false);
  // 默认直连；选择记在 localStorage，下次启动沿用
  const [useProxy, setUseProxy] = useState(false);
  // 账号 profile
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [activeProfile, setActiveProfile] = useState<string>('default');
  const [newProfileId, setNewProfileId] = useState('');
  const [newProfileLabel, setNewProfileLabel] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('Hello 来自个人号 🚀');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 联系人 / 最近会话
  type Chat = {
    chatId: string;
    waId: string;
    kind: 'phone' | 'lid' | 'group';
    name: string;
    /** WhatsApp 隐私模式联系人偶尔仍能拿到真实 E.164 号，用于在 UI 上佐证「是某某朋友」 */
    resolvedPhone?: string;
    unread: number;
    lastTimestamp: number;
    lastMessage?: string;
  };
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [chatsFilter, setChatsFilter] = useState('');
  // 号码校验
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<null | { registered: boolean; to: string }>(null);

  async function refresh() {
    try {
      const r = await fetch('/api/wa/personal/status', { cache: 'no-store' });
      setStatus(await r.json());
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // profile 列表加载一次即可（增删/切换后内部会自己 reload）
  useEffect(() => {
    loadProfiles();
  }, []);

  // 读取上次「是否使用代理」的选择
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const v = window.localStorage.getItem(USE_PROXY_KEY);
    if (v === '0') setUseProxy(false);
    else if (v === '1') setUseProxy(true);
  }, []);

  function toggleUseProxy(next: boolean) {
    setUseProxy(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(USE_PROXY_KEY, next ? '1' : '0');
    }
  }

  async function start() {
    setStarting(true);
    try {
      await fetch('/api/wa/personal/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ useProxy })
      });
      await refresh();
    } finally {
      setStarting(false);
    }
  }

  async function logout() {
    // 默认只停掉本地浏览器进程，保留 LocalAuth；下次启动可免扫。
    await fetch('/api/wa/personal/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wipeSession: false })
    });
    await refresh();
  }

  async function clearLocalSession() {
    if (!confirm('清除当前账号的本地登录 session？\n\n下次启动必须重新扫码，手机端“已连接的设备”里也可能需要手动清理旧设备。聊天记录不会被删除。')) return;
    await fetch('/api/wa/personal/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wipeSession: true })
    });
    await refresh();
  }

  async function loadProfiles() {
    try {
      const r = await fetch('/api/wa/personal/profiles', { cache: 'no-store' });
      const j = (await r.json()) as { active: string; profiles: ProfileInfo[] };
      setProfiles(j.profiles ?? []);
      setActiveProfile(j.active ?? 'default');
    } catch {
      /* ignore */
    }
  }

  async function addProfile() {
    setProfileError(null);
    const id = newProfileId.trim();
    if (!id) {
      setProfileError('请填一个账号 id');
      return;
    }
    setProfileBusy(true);
    try {
      const r = await fetch('/api/wa/personal/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, label: newProfileLabel.trim() || id })
      });
      const j = await r.json();
      if (!r.ok) {
        setProfileError(j?.reason ?? `HTTP ${r.status}`);
      } else {
        setNewProfileId('');
        setNewProfileLabel('');
        await loadProfiles();
      }
    } finally {
      setProfileBusy(false);
    }
  }

  async function switchProfile(nextId: string) {
    if (nextId === activeProfile) return;
    setProfileBusy(true);
    setProfileError(null);
    try {
      const r = await fetch('/api/wa/personal/profiles/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: nextId, wipeCurrentData: false, wipeCurrentSession: false })
      });
      const j = await r.json();
      if (!r.ok) {
        setProfileError(j?.reason ?? `HTTP ${r.status}`);
      } else {
        await Promise.all([loadProfiles(), refresh()]);
        // 切换后聊天列表需重拉
        setChats(null);
      }
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteProfile(id: string) {
    if (id === 'default') return;
    if (id === activeProfile) {
      alert('请先切换到其他账号，再删除这个。');
      return;
    }
    if (!confirm(`删除账号「${id}」？\n\n会同时清除该账号的本地浏览器 session 和聊天记录。不影响手机端。`)) return;
    setProfileBusy(true);
    try {
      const r = await fetch(`/api/wa/personal/profiles/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      const j = await r.json();
      if (!r.ok) setProfileError(j?.reason ?? `HTTP ${r.status}`);
      else await loadProfiles();
    } finally {
      setProfileBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/wa/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: testTo, text: testText, mode: 'personal' })
      });
      setTestResult(JSON.stringify(await res.json(), null, 2));
    } catch (e) {
      setTestResult('错误：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setTesting(false);
    }
  }

  async function loadChats() {
    setChatsLoading(true);
    setChatsError(null);
    try {
      const r = await fetch('/api/wa/personal/chats?limit=100', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) setChatsError(j?.error ?? `HTTP ${r.status}`);
      else setChats(j.chats ?? []);
    } catch (e) {
      setChatsError(e instanceof Error ? e.message : String(e));
    } finally {
      setChatsLoading(false);
    }
  }

  async function checkNumber() {
    if (!testTo) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await fetch('/api/wa/personal/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: testTo })
      });
      const j = await r.json();
      if (r.ok) setCheckResult({ registered: !!j.registered, to: testTo });
      else setCheckResult({ registered: false, to: testTo });
    } finally {
      setChecking(false);
    }
  }

  const state = status?.state ?? 'idle';
  const tone =
    state === 'ready'
      ? 'success'
      : state === 'qr' || state === 'authenticated' || state === 'initializing'
      ? 'warning'
      : state === 'auth_failure' || state === 'disconnected'
      ? 'warning'
      : 'muted';

  return (
    <>
      <div className="rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px] leading-5 text-blue-900">
        本页仅操作 <b>个人号（扫码登录）</b>。登录 / 退出 <b>不会影响</b> 商业号 Cloud API 配置。
      </div>

      {/* 账号 profile：每个 profile 一份独立的本地浏览器 session + 聊天记录文件。
          切换账号不会动手机端，手机上可以完整看到双方所有聊天历史。 */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-zinc-950">账号</h2>
            <p className="mt-1 text-xs text-zinc-500">
              在多个 WhatsApp 账号之间切换。每个账号在本地有独立的浏览器 session 和聊天记录文件；
              切换 / 退出 / 删除都只动本电脑，<b>不会影响手机端</b>。
            </p>
          </div>
        </div>

        <div className="mt-4 divide-y divide-zinc-100 rounded-md border border-zinc-200">
          {profiles.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-400">加载中…</div>
          ) : (
            profiles.map((p) => {
              const isActive = p.id === activeProfile;
              return (
                <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-950">{p.label}</span>
                      <code className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500">{p.id}</code>
                      {isActive ? <Badge tone="success">当前</Badge> : null}
                    </div>
                  </div>
                  {!isActive ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => switchProfile(p.id)}
                        disabled={profileBusy}
                      >
                        切到此账号
                      </Button>
                      {p.id !== 'default' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteProfile(p.id)}
                          disabled={profileBusy}
                        >
                          删除
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-zinc-500">新账号 id（小写字母/数字/_-）</label>
            <input
              type="text"
              value={newProfileId}
              onChange={(e) => setNewProfileId(e.target.value.toLowerCase())}
              placeholder="e.g. work"
              className="h-8 w-40 rounded border border-zinc-300 px-2 text-xs focus:border-[#5E6AD2] focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-zinc-500">显示名（可选）</label>
            <input
              type="text"
              value={newProfileLabel}
              onChange={(e) => setNewProfileLabel(e.target.value)}
              placeholder="e.g. 工作号"
              className="h-8 w-48 rounded border border-zinc-300 px-2 text-xs focus:border-[#5E6AD2] focus:outline-none"
            />
          </div>
          <Button variant="ghost" size="sm" onClick={addProfile} disabled={profileBusy}>
            添加
          </Button>
          {profileError ? <span className="text-xs text-red-600">{profileError}</span> : null}
        </div>
        <p className="mt-3 text-[11px] leading-5 text-zinc-400">
          切换账号只会停掉当前浏览器进程，默认保留各账号的本地 session 和聊天记录；下次切回通常可免扫码。
          只有点击「清除本地登录」或删除账号，才会移除对应 session。
        </p>
      </Card>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-zinc-950">个人号登录</h2>
            <p className="mt-1 text-xs text-zinc-500">
              扫码登录后会话存于本地 <code className="rounded bg-zinc-100 px-1">data/.wwebjs_auth</code>，无需重复扫码。
              基于非官方 whatsapp-web.js，仅适用于原型验证；Meta 可能封号，请用副号测试。
            </p>
            {status?.session ? (
              <p className="mt-1 text-[11px] text-zinc-400">
                当前 profile: {status.session.profileId} · {status.session.hasSession
                  ? status.session.invalid
                    ? '本地登录已保存但已失效，需要重新扫码'
                    : '已保存登录，可尝试免扫码恢复'
                  : '暂无本地登录，下次会显示二维码'} · {status.session.dir}
              </p>
            ) : null}
          </div>
          <Badge tone={tone as 'success' | 'warning' | 'muted'}>{state}</Badge>
        </div>

        <div className="mt-4">
          {state === 'ready' && status?.me ? (
            <div className="flex items-center gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs">
              <div>
                <p className="font-medium text-zinc-950">
                  {status.me.name ?? '已登录'}
                </p>
                <p className="text-zinc-500">{status.me.id}</p>
              </div>
              <div className="ml-auto">
                <Button variant="ghost" size="sm" onClick={logout}>
                  停止客户端
                </Button>
              </div>
            </div>
          ) : state === 'qr' && status?.qr ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-zinc-200 bg-white p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={status.qr} alt="WhatsApp QR" className="h-64 w-64" />
              <p className="text-center text-xs text-zinc-500">
                打开 WhatsApp → 设置 → 已连接的设备 → 连接设备 → 扫描此码
              </p>
              {status.session?.invalid ? (
                <p className="max-w-md text-center text-[11px] text-red-600">
                  检测到本地 session 文件仍在，但 WhatsApp Web 没有接受这份登录态。
                  这通常表示手机端已删除/失效了该已连接设备，或上次浏览器异常退出导致本地登录态损坏；需要重新扫码一次。
                </p>
              ) : null}
              <p className="max-w-xs text-center text-[11px] text-amber-700">
                若手机提示「无法关联设备」，通常是已连接设备已满（每个账号最多 4 个）。
                请先在手机 WhatsApp → 已连接的设备 中删除旧/失效的设备，再回来重新扫码。
              </p>
            </div>
          ) : state === 'initializing' || state === 'authenticated' ? (
            <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-500">
              <p>{state === 'initializing' ? '正在启动浏览器…' : '已扫码，正在同步会话…'}</p>
              {status?.startedAt ? (
                <p className="text-[11px] text-zinc-400">
                  已耗时 {Math.max(0, Math.round((Date.now() - status.startedAt) / 1000))}s
                  {status?.proxy?.inUse ? ` · 走代理 ${status.proxy.inUse}` : ' · 未走代理'}
                </p>
              ) : null}
              {status?.proxy?.inUse ? (
                <p className="text-[11px] text-amber-700">
                  如果卡超过 60–90s，多半是代理在同步 WhatsApp Web 资源时慢或断连。
                  可以点「退出登录」后，取消下面「通过代理启动」勾选重试。
                </p>
              ) : null}
              <div className="pt-1">
                <Button variant="ghost" size="sm" onClick={logout}>
                  停止重试
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-xs text-zinc-500">
                {status?.session?.hasSession
                  ? '点击下方按钮启动 WhatsApp 客户端进程，优先使用已保存登录免扫码恢复。'
                  : '点击下方按钮启动 WhatsApp 客户端进程；没有本地 session 时会生成登录二维码。'}
              </p>
              {status?.proxy?.configured ? (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700">
                  <input
                    type="checkbox"
                    checked={useProxy}
                    onChange={(e) => toggleUseProxy(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-[#5E6AD2] focus:ring-[#5E6AD2]"
                  />
                  <span>
                    通过代理启动
                    <span className="ml-1 text-[11px] text-zinc-400">
                      ({status.proxy.configuredServer ?? 'WA_PROXY_SERVER'})
                    </span>
                  </span>
                </label>
              ) : (
                <p className="text-[11px] text-zinc-400">
                  未配置 WA_PROXY_SERVER，将直连启动。若系统 VPN 已经接管网络，通常无需单独配置代理。
                </p>
              )}
              <Button variant="primary" onClick={start} disabled={starting}>
                {starting ? '启动中…' : status?.session?.hasSession ? '启动并恢复登录' : '启动并显示二维码'}
              </Button>
              {status?.session?.hasSession ? (
                <Button variant="ghost" size="sm" onClick={clearLocalSession}>
                  清除本地登录
                </Button>
              ) : null}
            </div>
          )}

          {status?.lastError ? (
            <p className="mt-3 text-xs text-red-600">{status.lastError}</p>
          ) : null}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-medium text-zinc-950">发送测试消息</h2>
        <p className="mt-1 text-xs text-zinc-500">
          需要先登录成功（状态为 ready）。<br />
          <span className="text-amber-700">
            提示：<code className="rounded bg-amber-50 px-1">No LID for user</code>{' '}
            表示该号码未注册 WhatsApp（或未与你互加 / 未保存联系人）。请用「我的联系人」选一个真实在线的号码测试。
          </span>
        </p>

        {/* 我的 WhatsApp 联系人 / 最近会话 */}
        <div className="mt-4 rounded-md border border-zinc-200">
          <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2">
            <h3 className="text-xs font-medium text-zinc-700">我的联系人 / 最近会话</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={loadChats}
              disabled={state !== 'ready' || chatsLoading}
              className="ml-auto"
            >
              {chatsLoading ? '加载中…' : chats ? '刷新' : '加载'}
            </Button>
          </div>
          {state !== 'ready' ? (
            <p className="px-3 py-3 text-xs text-zinc-500">登录成功后可加载真实联系人。</p>
          ) : chatsError ? (
            <p className="px-3 py-3 text-xs text-red-600">{chatsError}</p>
          ) : !chats ? (
            <p className="px-3 py-3 text-xs text-zinc-500">
              点「加载」拉取 WhatsApp Web 上的最近会话（一对一，最多 100 条）。
            </p>
          ) : chats.length === 0 ? (
            <p className="px-3 py-3 text-xs text-zinc-500">暂无会话。试着先在手机上给某人发条消息再回来刷新。</p>
          ) : (
            <>
              <div className="px-3 py-2">
                <Input
                  value={chatsFilter}
                  onChange={(e) => setChatsFilter(e.target.value)}
                  placeholder="搜索姓名 / 号码"
                />
              </div>
              <div className="max-h-64 overflow-y-auto">
                {chats
                  .filter((c) => {
                    const q = chatsFilter.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      c.name.toLowerCase().includes(q) || c.waId.includes(q.replace(/\D/g, ''))
                    );
                  })
                  .map((c) => {
                    const isLid = c.kind === 'lid';
                    // 点击后填入「To」：LID 用完整 chatId 直发；电话号用 waId（纯数字）
                    const fillValue = isLid ? c.chatId : c.waId;
                    // WhatsApp 隐私改版后大量真实联系人也以 LID 寻址。
                    // 后端 listPersonalChats 会顺手拉一次 contact.number——如果能拿到，就在副标题
                    // 显示真实 +号，避免用户误以为「我的朋友怎么都成了私密匿名号」。
                    const subtitle = isLid
                      ? c.resolvedPhone
                        ? `+${c.resolvedPhone} · WA 隐私寻址`
                        : `WA 隐私寻址（未公开电话号）`
                      : `+${c.waId}`;
                    return (
                      <button
                        key={c.chatId}
                        type="button"
                        onClick={() => {
                          setTestTo(fillValue);
                          setCheckResult(null);
                        }}
                        className={`flex w-full items-center gap-3 border-t border-zinc-100 px-3 py-2 text-left text-xs hover:bg-zinc-50 ${
                          testTo === fillValue ? 'bg-[#5E6AD2]/5' : ''
                        }`}
                      >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-medium text-zinc-700">
                          {c.name.slice(0, 1)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-zinc-950">{c.name}</span>
                            {isLid ? (
                              <span
                                className="rounded bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-800"
                                title="WhatsApp 隐私模式：自 2024 末新好友默认仅以 LID（隐私 ID）寻址，即使已加你为好友的联系人也可能显示『私密』。不影响发送。"
                              >
                                私密
                              </span>
                            ) : null}
                            {c.unread > 0 ? (
                              <span className="rounded-full bg-emerald-500 px-1.5 text-[10px] font-semibold text-white">
                                {c.unread}
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-[11px] text-zinc-500">
                            {subtitle}
                            {c.lastMessage ? ` · ${c.lastMessage}` : ''}
                          </div>
                        </div>
                        {c.lastTimestamp ? (
                          <span className="shrink-0 text-[10px] text-zinc-400">
                            {new Date(c.lastTimestamp).toLocaleDateString('zh-CN', {
                              month: '2-digit',
                              day: '2-digit'
                            })}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
              </div>
            </>
          )}
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <Field
              name="wa-personal-test-to"
              label="To (E.164，不带 +；LID 联系人会自动用 <id>@lid)"
              hint="点上面联系人自动填入；或手输 86138..."
              value={testTo}
              onChange={(v) => {
                setTestTo(v);
                setCheckResult(null);
              }}
              placeholder="86138... 或 <lid>@lid"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={checkNumber}
                disabled={state !== 'ready' || !testTo || checking || testTo.includes('@')}
                title={testTo.includes('@') ? 'LID 联系人无法校验电话号，直接点「发送」即可' : ''}
              >
                {checking ? '校验中…' : '校验该号码是否在 WhatsApp'}
              </Button>
              {testTo.includes('@lid') ? (
                <span className="text-[11px] text-amber-700">
                  LID 联系人（隐私模式）—— 跳过电话校验，可直接发送
                </span>
              ) : checkResult ? (
                checkResult.registered ? (
                  <Badge tone="success">+{checkResult.to} 已注册 WhatsApp</Badge>
                ) : (
                  <Badge tone="warning">+{checkResult.to} 未注册 / 无法发送</Badge>
                )
              ) : null}
            </div>
          </div>
          <div>
            <Label>内容</Label>
            <textarea
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-950 placeholder:text-zinc-400 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
            />
          </div>
          <Button
            variant="primary"
            onClick={sendTest}
            disabled={state !== 'ready' || !testTo || !testText || testing}
          >
            {testing ? '发送中…' : '发送'}
          </Button>
        </div>
        {testResult ? (
          <>
            <Divider className="my-4" />
            <pre className="max-h-64 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-100">
              {testResult}
            </pre>
          </>
        ) : null}
      </Card>
    </>
  );
}

// ===================== Cloud API (Meta) =====================

function CloudPanel() {
  const [cfg, setCfg] = useState<WaConfig>({
    phoneNumberId: '',
    accessToken: '',
    businessAccountId: '',
    webhookVerifyToken: '',
    displayPhone: ''
  });
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // test send
  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('Hello from WhatsApp AI Sales 🚀');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    const stored = loadWaConfig();
    if (stored) setCfg((c) => ({ ...c, ...stored }));
    setLoaded(true);
  }, []);

  /**
   * Meta Cloud ID 字段校验：phoneNumberId / businessAccountId 必须是纯数字（15-18 位）。
   * 这里有意设严：用户曾把 Azure endpoint URL 误粘进去，产生所有发送皆报错又很难定位。
   */
  function validateMetaId(v: string): boolean {
    return /^\d{10,20}$/.test(v.trim());
  }
  const phoneNumberIdInvalid = cfg.phoneNumberId.trim().length > 0 && !validateMetaId(cfg.phoneNumberId);
  const businessAccountIdInvalid =
    (cfg.businessAccountId ?? '').trim().length > 0 && !validateMetaId(cfg.businessAccountId ?? '');
  const accessTokenInvalid =
    cfg.accessToken.trim().length > 0 && !/^EAA/i.test(cfg.accessToken.trim());
  const blocked = phoneNumberIdInvalid || businessAccountIdInvalid || accessTokenInvalid;

  function save() {
    if (blocked) return;
    saveWaConfig({
      ...cfg,
      phoneNumberId: cfg.phoneNumberId.trim(),
      accessToken: cfg.accessToken.trim(),
      businessAccountId: (cfg.businessAccountId ?? '').trim(),
      displayPhone: (cfg.displayPhone ?? '').trim()
    });
    setSavedAt(Date.now());
  }

  function clear() {
    if (!confirm('清除本地保存的【商业号 Cloud API】凭证？\n\n仅影响本页商业号配置，不会影响个人号扫码登录状态。')) return;
    clearWaConfig();
    setCfg({
      phoneNumberId: '',
      accessToken: '',
      businessAccountId: '',
      webhookVerifyToken: '',
      displayPhone: ''
    });
    setSavedAt(null);
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/wa/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: testTo,
          text: testText,
          mode: 'cloud',
          phoneNumberId: cfg.phoneNumberId,
          accessToken: cfg.accessToken
        })
      });
      const json = await res.json();
      setTestResult(JSON.stringify(json, null, 2));
    } catch (e: unknown) {
      setTestResult('错误：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setTesting(false);
    }
  }

  const configured = isWaConfigured(cfg);

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px] leading-5 text-blue-900">
          本页仅配置 <b>商业号 (Meta Cloud API)</b>。保存 / 清除 <b>不会影响</b> 个人号扫码登录。
        </div>
        <Badge tone={configured ? 'success' : 'warning'}>
          {configured ? '商业号已配置' : '商业号未配置'}
        </Badge>
      </div>
      <Card className="p-5">
          <h2 className="text-sm font-medium text-zinc-950">凭证</h2>
          <p className="mt-1 text-xs text-zinc-500">
            从{' '}
            <a
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noreferrer"
              className="text-[#5E6AD2] hover:underline"
            >
              Meta for Developers
            </a>{' '}
            → WhatsApp → API Setup 拿到下面这两个值。
          </p>

          <div className="mt-4 space-y-3">
            <Field
              name="wa-phone-number-id"
              label="Phone Number ID"
              hint="纯数字 ID（不是 URL，不是手机号，通常 15-17 位）。在 Meta for Developers → WhatsApp → API Setup 页面的 Phone numbers 表格中复制。"
              value={cfg.phoneNumberId}
              onChange={(v) => setCfg({ ...cfg, phoneNumberId: v })}
              placeholder="572812345678901"
              error={
                phoneNumberIdInvalid
                  ? '格式不对：该值必须是 10-20 位纯数字。不要粘 URL、手机号或邮箱。'
                  : undefined
              }
            />
            <Field
              name="wa-access-token"
              label="Access Token"
              hint="以 EAA 开头的长字符串。临时 token 24h 过期；生产请用 System User permanent token。"
              value={cfg.accessToken}
              onChange={(v) => setCfg({ ...cfg, accessToken: v })}
              placeholder="EAAGm0X9ZBxxxxxxx... (长度通常 200+ 字符)"
              type="password"
              error={accessTokenInvalid ? '格式不对：Meta Access Token 应以 EAA 开头。' : undefined}
            />
            <Field
              name="wa-display-phone"
              label="Display Phone（仅展示）"
              hint="可选；用于 Inbox 顶栏显示该商业号的手机号，不参与调用。"
              value={cfg.displayPhone ?? ''}
              onChange={(v) => setCfg({ ...cfg, displayPhone: v })}
              placeholder="+8613800001234"
            />
            <Field
              name="wa-business-account-id"
              label="Business Account ID (WABA ID)"
              hint="可选；纯数字，发送模版消息（template message）时需要。与上面的 Phone Number ID 是两个不同的 ID。"
              value={cfg.businessAccountId ?? ''}
              onChange={(v) => setCfg({ ...cfg, businessAccountId: v })}
              placeholder="104291988291234"
              error={
                businessAccountIdInvalid
                  ? '格式不对：该值必须是 10-20 位纯数字。看起来像 URL 的是别的系统的地址。'
                  : undefined
              }
            />
          </div>

          <div className="mt-5 flex items-center gap-2">
            <Button variant="primary" onClick={save} disabled={!loaded || blocked}>
              保存商业号配置
            </Button>
            <Button variant="ghost" onClick={clear}>
              清除商业号配置
            </Button>
            {savedAt ? (
              <span className="text-xs text-zinc-500">
                已保存 · {new Date(savedAt).toLocaleTimeString('zh-CN')}
              </span>
            ) : null}
            {blocked ? (
              <span className="text-xs text-red-600">请先修正上面高亮的格式错误才能保存</span>
            ) : null}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-medium text-zinc-950">Webhook</h2>
          <p className="mt-1 text-xs text-zinc-500">
            把下面这个 URL 配置到 Meta WhatsApp Cloud API → Webhooks。生产环境需 https。
          </p>

          <div className="mt-3 space-y-2 text-xs">
            <KV
              k="Callback URL"
              v={
                typeof window !== 'undefined'
                  ? `${window.location.origin}/api/wa/webhook`
                  : '/api/wa/webhook'
              }
            />
            <KV
              k="Verify Token"
              v={
                <>
                  <code className="rounded bg-zinc-100 px-1.5 py-0.5">
                    {cfg.webhookVerifyToken || 'dev-verify-token'}
                  </code>
                  <span className="ml-2 text-zinc-400">
                    （改值请在服务端 .env 设置 <code>WA_WEBHOOK_VERIFY_TOKEN</code>）
                  </span>
                </>
              }
            />
            <KV k="订阅字段" v="messages, message_status" />
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-medium text-zinc-950">发送测试消息</h2>
          <p className="mt-1 text-xs text-zinc-500">
            收件人必须在过去 24h 内主动联系过你的号码，否则需要先用模版消息。
          </p>

          <div className="mt-4 space-y-3">
            <Field
              name="wa-test-to"
              label="To (E.164 格式)"
              hint="例如 8613800001111，不带 +"
              value={testTo}
              onChange={setTestTo}
              placeholder="86138..."
            />
            <div>
              <Label>内容</Label>
              <textarea
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-950 placeholder:text-zinc-400 focus:border-[#5E6AD2] focus:outline-none focus:ring-2 focus:ring-[#5E6AD2]/30"
              />
            </div>
            <Button
              variant="primary"
              onClick={sendTest}
              disabled={!configured || !testTo || !testText || testing}
            >
              {testing ? '发送中…' : '发送'}
            </Button>
          </div>

          {testResult ? (
            <>
              <Divider className="my-4" />
              <pre className="max-h-64 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-100">
                {testResult}
              </pre>
            </>
          ) : null}
        </Card>
    </>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  name,
  error
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  name?: string;
  /** 可选校验错误提示；传入则输入框变红边 + 下方显示红色文案 */
  error?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        name={name}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        // 阻止 1Password / Bitwarden 自动填充
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
        className={error ? 'border-red-400 focus:border-red-500 focus:ring-red-200' : undefined}
      />
      {error ? (
        <p className="mt-1 text-[11px] text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-zinc-400">{hint}</p>
      ) : null}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="w-32 shrink-0 text-zinc-500">{k}</span>
      <span className="break-all text-zinc-800">{v}</span>
    </div>
  );
}
