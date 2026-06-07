'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Label, Card, Badge, Divider, Select } from '@/lib/ui/primitives';
import {
  AI_MODEL_PRESETS,
  loadAiConfig,
  saveAiConfig,
  clearAiConfig,
  isAiConfigured,
  getEffectiveModel,
  type AiConfig
} from '@/lib/ai/config';

export default function AiSettingsPage() {
  // 服务端渲染时不能读 localStorage，必须用一个稳定的空配置作为初始值，
  // 避免 hydration mismatch（之前会出现 Server:"未配置" / Client:"已配置"）。
  const [cfg, setCfg] = useState<AiConfig>(() => ({
    provider: 'azure-foundry',
    endpoint: '',
    apiKey: '',
    modelPreset: 'gpt-5.4',
    customModel: ''
  }));
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | {
    ok: boolean;
    elapsedMs?: number;
    reason?: string;
    sample?: string;
    modelEcho?: string;
  }>(null);

  useEffect(() => {
    setCfg(loadAiConfig());
    setLoaded(true);
  }, []);

  function save() {
    saveAiConfig(cfg);
    setSavedAt(Date.now());
    // 同步一份到服务端，让后端自动响应（DRAFT_AUTO / AUTO_SAFE / AUTO_FULL）
    // 以及 AI 识别联系人 / 商品 等服务端入口也能用同一份配置；失败不阻塞前端。
    if (isAiConfigured(cfg)) {
      fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: cfg.endpoint,
          apiKey: cfg.apiKey,
          model: getEffectiveModel(cfg)
        })
      }).catch(() => {});
    }
  }

  function clear() {
    if (!confirm('清除本地保存的 AI 模型配置？')) return;
    clearAiConfig();
    setCfg(loadAiConfig());
    setSavedAt(null);
    setTestResult(null);
    // 同步清掉服务端文件
    fetch('/api/ai/config', { method: 'DELETE' }).catch(() => {});
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/ai/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: cfg.endpoint,
          apiKey: cfg.apiKey,
          model: getEffectiveModel(cfg)
        })
      });
      setTestResult(await r.json());
    } catch (e) {
      setTestResult({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  const configured = isAiConfigured(cfg);

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-8 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-zinc-950">AI 模型</h1>
            <p className="text-xs text-zinc-500">
              用于商品归一化、图片识别、营销话术等任务。凭证仅保存在浏览器 localStorage。
            </p>
          </div>
          <Badge tone={!loaded ? 'muted' : configured ? 'success' : 'warning'}>
            {!loaded ? '加载中' : configured ? '已配置' : '未配置'}
          </Badge>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-6 px-8 py-6">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-950">Provider</h2>
            <Badge tone="accent">Azure AI Foundry</Badge>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            走 Responses API（多模态），路径{' '}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5">/openai/v1/responses</code>。
            模型支持多模态视觉时 (gpt-5.4) 可直接看商品组图识别型号、烫印 logo、皮签等。
          </p>

          <div className="mt-4 space-y-3">
            <Field
              name="ai-endpoint"
              label="Endpoint"
              hint="例如 https://your-resource.cognitiveservices.azure.com"
              value={cfg.endpoint}
              onChange={(v) => setCfg({ ...cfg, endpoint: v })}
              placeholder="https://....cognitiveservices.azure.com"
            />
            <Field
              name="ai-key"
              label="API Key"
              hint="Azure Portal → Keys and Endpoint"
              value={cfg.apiKey}
              onChange={(v) => setCfg({ ...cfg, apiKey: v })}
              placeholder="..."
              type="password"
            />
            <div>
              <Label>模型 / Deployment</Label>
              <Select
                value={cfg.modelPreset}
                onChange={(e) => setCfg({ ...cfg, modelPreset: e.target.value })}
              >
                {AI_MODEL_PRESETS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                    {m.recommended ? ' ★' : ''}
                  </option>
                ))}
              </Select>
            </div>
            {cfg.modelPreset === 'custom' ? (
              <Field
                name="ai-custom-model"
                label="自定义 deployment 名"
                value={cfg.customModel}
                onChange={(v) => setCfg({ ...cfg, customModel: v })}
                placeholder="my-gpt-deployment"
              />
            ) : null}

            <Divider className="my-2" />
            <div>
              <Label>「AI 检索 / 筛选」专用模型（可选）</Label>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                用于 Catalog 自然语言检索这类纯文本任务。留「跟随主模型」即可；想省成本可切到 gpt-5.4-mini。
              </p>
              <Select
                className="mt-1.5"
                value={cfg.searchModelPreset ?? ''}
                onChange={(e) => setCfg({ ...cfg, searchModelPreset: e.target.value })}
              >
                <option value="">跟随主模型（{getEffectiveModel(cfg) || '未配置'}）</option>
                {AI_MODEL_PRESETS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </div>
            {cfg.searchModelPreset === 'custom' ? (
              <Field
                name="ai-search-custom-model"
                label="检索场景的自定义 deployment 名"
                value={cfg.searchCustomModel ?? ''}
                onChange={(v) => setCfg({ ...cfg, searchCustomModel: v })}
                placeholder="my-gpt-mini-deployment"
              />
            ) : null}
          </div>

          <div className="mt-5 flex items-center gap-2">
            <Button variant="primary" onClick={save} disabled={!loaded}>
              保存
            </Button>
            <Button variant="ghost" onClick={clear}>
              清除
            </Button>
            <Button variant="secondary" onClick={test} disabled={!configured || testing}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            {savedAt ? (
              <span className="text-xs text-zinc-500">
                已保存 · {new Date(savedAt).toLocaleTimeString('zh-CN')}
              </span>
            ) : null}
          </div>

          {testResult ? (
            <>
              <Divider className="my-4" />
              <div
                className={`rounded-md px-3 py-2 text-xs ${
                  testResult.ok
                    ? 'bg-emerald-50 text-emerald-800'
                    : 'bg-red-50 text-red-700'
                }`}
              >
                {testResult.ok ? (
                  <>
                    <p className="font-medium">连接成功</p>
                    <p className="mt-1 text-emerald-700">
                      模型 {testResult.modelEcho} · 用时 {testResult.elapsedMs} ms
                    </p>
                    {testResult.sample ? (
                      <p className="mt-1 font-mono text-[11px] text-emerald-700">
                        样本输出：{testResult.sample}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="font-medium">连接失败</p>
                    <p className="mt-1 break-all">{testResult.reason}</p>
                  </>
                )}
              </div>
            </>
          ) : null}
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-medium text-zinc-950">使用场景</h2>
          <ul className="mt-3 space-y-2 text-xs text-zinc-600">
            <li className="flex gap-2">
              <span className="font-mono text-zinc-400">·</span>
              <span>
                <strong>商品归一化</strong>：从 SPA 详情页 + 商品组图 + 整页截图，提取品牌 /
                系列 / 型号 / 货号 / 性别 / 颜色 / 材质 / 尺寸 / 卖点
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-zinc-400">·</span>
              <span>
                <strong>主图视觉识别</strong>：通过烫印 logo、皮签、Monogram 老花等图像证据反推
                brand/model
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-zinc-400">·</span>
              <span>
                <strong>话术生成</strong>（后续）：根据商品 catalog 字段一键生成 WhatsApp
                推送文案
              </span>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  name
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  name?: string;
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
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
      />
      {hint ? <p className="mt-1 text-[11px] text-zinc-400">{hint}</p> : null}
    </div>
  );
}
