'use client';

import { useEffect, useMemo, useState } from 'react';

type CardResponse = {
  card: {
    mainImage: string;
    title: string;
    brand: string;
    series: string;
    model: string;
    categoryPath: string[];
    price: string;
    merchant: string;
    galleryImageCount: number;
    extractedAttributes: string[];
    sourceUrl: string;
    galleryImages: string[];
    confidence: { overall: number; source: 'llm' | 'heuristic'; notes?: string };
  };
  raw: {
    sourceUrl: string;
    code: string;
    titleCandidates: string[];
    priceCandidates: string[];
    merchantCandidates: string[];
    brandCandidates: string[];
    modelCandidates: string[];
    descriptionBlocks: string[];
    imageCount: number;
    images: string[];
    renderedBodyText?: string;
    screenshotPresent?: boolean;
  };
};

type AzureConfig = {
  endpoint: string;
  apiKey: string;
  modelPreset: string;
  customModel: string;
};

const DEFAULT_INPUT = 'https://mall.gxhyapp.com/market/web/detailIndex?marketCode=gz&code=1190184416';
const DEFAULT_MAIN_IMAGE =
  'https://product.aliyizhan.com/person/7f0e2f3a4e804e93a68dae625167af7a/c6d984c14c1f456e8e183444586f234e/0.jpg';
const AZURE_CONFIG_KEY = 'gxhyapp_azure_config_v1';
const MODEL_OPTIONS = [
  { value: 'gpt-5.4', label: 'gpt-5.4' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  { value: 'gpt-5-mini', label: 'gpt-5-mini' },
  { value: 'model-router', label: 'model-router' },
  { value: 'custom', label: '自定义 deployment' }
];
const DEFAULT_CONFIG: AzureConfig = {
  endpoint: '',
  apiKey: '',
  modelPreset: 'gpt-5.4',
  customModel: ''
};

function getSelectedModel(config: AzureConfig): string {
  return config.modelPreset === 'custom'
    ? String(config.customModel || '').trim()
    : String(config.modelPreset || '').trim();
}

function isConfigReady(config: AzureConfig): boolean {
  return !!(config.endpoint.trim() && config.apiKey.trim() && getSelectedModel(config));
}

function readStoredConfig(): AzureConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(AZURE_CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function GxhyappScrapePlayground() {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [mainImageUrl, setMainImageUrl] = useState(DEFAULT_MAIN_IMAGE);
  const [extraText, setExtraText] = useState('');
  const [useRenderer, setUseRenderer] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CardResponse | null>(null);
  const [azureConfig, setAzureConfig] = useState<AzureConfig>(DEFAULT_CONFIG);
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<AzureConfig>(DEFAULT_CONFIG);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  useEffect(() => {
    if (!zoomImage) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setZoomImage(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomImage]);

  useEffect(() => {
    const stored = readStoredConfig();
    setAzureConfig(stored);
    setConfigDraft(stored);
  }, []);

  const ready = useMemo(() => isConfigReady(azureConfig), [azureConfig]);
  const selectedModel = useMemo(() => getSelectedModel(azureConfig), [azureConfig]);

  function saveConfig() {
    const cleaned: AzureConfig = {
      endpoint: configDraft.endpoint.trim(),
      apiKey: configDraft.apiKey.trim(),
      modelPreset: configDraft.modelPreset,
      customModel: configDraft.customModel.trim()
    };
    setAzureConfig(cleaned);
    try {
      window.localStorage.setItem(AZURE_CONFIG_KEY, JSON.stringify(cleaned));
    } catch {
      /* ignore */
    }
    setConfigOpen(false);
  }

  function clearConfig() {
    setAzureConfig(DEFAULT_CONFIG);
    setConfigDraft(DEFAULT_CONFIG);
    try {
      window.localStorage.removeItem(AZURE_CONFIG_KEY);
    } catch {
      /* ignore */
    }
  }

  async function runScrape() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const base = /^https?:\/\//.test(input.trim())
        ? { url: input.trim() }
        : { code: input.trim() };

      const body: Record<string, unknown> = { ...base };
      if (mainImageUrl.trim()) {
        body.mainImageUrl = mainImageUrl.trim();
      }
      if (extraText.trim()) {
        body.extraText = extraText.trim();
      }
      body.useRenderer = useRenderer;
      if (ready) {
        body.azure = {
          endpoint: azureConfig.endpoint,
          apiKey: azureConfig.apiKey,
          model: selectedModel
        };
      }

      const res = await fetch('/api/suppliers/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setResult(json as CardResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : '抓取失败');
    } finally {
      setLoading(false);
    }
  }

  const card = result?.card;
  const raw = result?.raw;

  return (
    <section className="rounded-3xl border bg-white p-6 shadow-sm md:p-8">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-500">单品抓取实验台</p>
          <h2 className="mt-3 text-3xl font-black text-slate-950">爬取 gxhyapp 详情页 + LLM 归一化</h2>
        </div>
        <p className="max-w-xl text-sm leading-7 text-slate-500 md:text-right">
          输入详情页 URL 或商品 code，调用 <code>/api/suppliers/scrape</code> 抓取首屏 HTML，提炼成 inbox
          可直接渲染的商品卡。模型走 Azure AI Foundry Responses API（默认 <code>gpt-5.4</code>）。
        </p>
      </div>

      {/* 模型配置状态条 */}
      <div className="mt-6 flex flex-col gap-2 rounded-2xl border bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full ${
              ready ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
          />
          {ready ? (
            <span className="text-slate-700">
              Azure 已配置 · 模型 <span className="font-mono font-semibold">{selectedModel}</span> ·
              endpoint{' '}
              <span className="font-mono text-xs text-slate-500">
                {azureConfig.endpoint.replace(/^https?:\/\//, '').slice(0, 48)}
                {azureConfig.endpoint.length > 56 ? '…' : ''}
              </span>
            </span>
          ) : (
            <span className="text-slate-700">
              未配置 Azure 模型，将走本地启发式归一化（或服务端 <code>.env</code> 中的{' '}
              <code>AZURE_OPENAI_*</code>）
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setConfigDraft(azureConfig);
              setConfigOpen((v) => !v);
            }}
            className="rounded-full border bg-white px-4 py-2 text-xs font-semibold"
          >
            {configOpen ? '收起配置' : ready ? '修改模型配置' : '配置模型'}
          </button>
          {ready ? (
            <button
              type="button"
              onClick={clearConfig}
              className="rounded-full border bg-white px-4 py-2 text-xs font-semibold text-rose-600"
            >
              清除
            </button>
          ) : null}
        </div>
      </div>

      {/* 配置面板 */}
      {configOpen ? (
        <div className="mt-3 rounded-2xl border bg-white p-5">
          <p className="text-sm font-semibold text-slate-700">Azure AI Foundry / Azure OpenAI</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            配置仅保存在本机浏览器 localStorage，每次请求随 body 发送给本服务的 API
            路由。若清空配置，服务端会回落到 <code>.env</code> 中的 <code>AZURE_OPENAI_*</code> 或本地启发式。
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Azure Endpoint">
              <input
                value={configDraft.endpoint}
                onChange={(e) => setConfigDraft({ ...configDraft, endpoint: e.target.value })}
                placeholder="https://YOUR-RESOURCE.openai.azure.com"
                className="w-full rounded-lg border bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none"
              />
            </Field>
            <Field label="Azure API Key">
              <input
                value={configDraft.apiKey}
                onChange={(e) => setConfigDraft({ ...configDraft, apiKey: e.target.value })}
                type="password"
                placeholder="Azure API Key"
                autoComplete="off"
                className="w-full rounded-lg border bg-slate-50 px-3 py-2 text-sm font-mono focus:bg-white focus:outline-none"
              />
            </Field>
            <Field label="Deployment / Model">
              <select
                value={configDraft.modelPreset}
                onChange={(e) => setConfigDraft({ ...configDraft, modelPreset: e.target.value })}
                className="w-full rounded-lg border bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
            {configDraft.modelPreset === 'custom' ? (
              <Field label="Custom Deployment Name">
                <input
                  value={configDraft.customModel}
                  onChange={(e) => setConfigDraft({ ...configDraft, customModel: e.target.value })}
                  placeholder="your-deployment-name"
                  className="w-full rounded-lg border bg-slate-50 px-3 py-2 text-sm font-mono focus:bg-white focus:outline-none"
                />
              </Field>
            ) : null}
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={saveConfig}
              disabled={!isConfigReady(configDraft)}
              className="rounded-full bg-slate-950 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              保存配置
            </button>
            <button
              type="button"
              onClick={() => {
                setConfigDraft(azureConfig);
                setConfigOpen(false);
              }}
              className="rounded-full border bg-white px-5 py-2 text-sm font-semibold"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 md:flex-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="详情页 URL 或商品 code，如 1190184416"
          className="flex-1 rounded-full border bg-slate-50 px-5 py-3 text-sm focus:bg-white focus:outline-none"
        />
        <button
          type="button"
          onClick={runScrape}
          disabled={loading || !input.trim()}
          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? '抓取中…' : '开始抓取并归一化'}
        </button>
      </div>

      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={useRenderer}
          onChange={(e) => setUseRenderer(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
        <span>
          <span className="font-semibold text-slate-800">用 Playwright 渲染 SPA</span>
          （无头 Chromium 打开页面 → hydrate → 整页截图 + innerText 一并送 LLM；自动绕过 SPA 空壳，
          <span className="text-slate-400">首次约 3-6s</span>）
        </span>
      </label>

      <div className="mt-3">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            主图链接（推荐填写 · 用于绕过 SPA 拿到完整组图）
          </span>
          <input
            value={mainImageUrl}
            onChange={(e) => setMainImageUrl(e.target.value)}
            placeholder="https://product.aliyizhan.com/person/.../0.jpg"
            className="mt-2 w-full rounded-full border bg-slate-50 px-5 py-3 text-xs font-mono focus:bg-white focus:outline-none"
          />
        </label>
        <p className="mt-1.5 text-xs leading-5 text-slate-500">
          gxhyapp 详情页是 SPA，裸 HTML 抓不到商品数据。如果你提供主图链接，scraper 会按
          <code>0.jpg / 1.jpg / …</code> 自动枚举出全部组图，并把它们交给 gpt-5.4
          视觉模型识别品牌 / 型号 / 品类。
        </p>
      </div>

      <div className="mt-3">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            补充文本信号（可选 · 从真实页面复制价格/商家/描述等）
          </span>
          <textarea
            value={extraText}
            onChange={(e) => setExtraText(e.target.value)}
            placeholder={`把 gxhyapp 页面里的文字直接复制进来，例如：\n¥ 690\n本款Nano Diane手袋，型号：M83566，83298动态芯片版\n材料：A级全钢五金，进口原厂面料\n尺寸：19*10.5*6CM\n小枣高端包包`}
            rows={5}
            className="mt-2 w-full rounded-2xl border bg-slate-50 px-4 py-3 text-xs font-mono leading-6 focus:bg-white focus:outline-none"
          />
        </label>
        <p className="mt-1 text-xs leading-5 text-slate-400">
          SPA 动态内容（价格、商家名、型号、尺寸）只存在于 gxhyapp 的后端接口里，服务端爬不到。把页面文字复制粘贴到这里，会直接作为文字信号送给 LLM，让它提取价格 / 商家 / 规格。
        </p>
      </div>

      {error ? (
        <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {card ? (
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
          <article className="overflow-hidden rounded-2xl border">
            {card.mainImage ? (
              <button
                type="button"
                onClick={() => setZoomImage(card.mainImage)}
                className="group relative block h-64 w-full overflow-hidden"
                title="点击放大查看"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={card.mainImage}
                  alt={card.title}
                  className="h-64 w-full object-cover transition group-hover:scale-105"
                />
                <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-1 text-[10px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                  🔍 放大
                </span>
              </button>
            ) : (
              <div className="flex h-64 w-full items-center justify-center bg-slate-100 text-sm text-slate-400">
                未抓到主图
              </div>
            )}
            <div className="space-y-3 p-5">
              <h3 className="text-lg font-bold text-slate-950">{card.title}</h3>
              <p className="text-sm font-bold text-blue-600">
                {card.brand} · {card.series} · {card.model}
              </p>
              <p className="text-sm text-slate-500">{card.categoryPath.join(' / ')}</p>
              <p className="text-2xl font-black text-rose-600">{card.price}</p>
              <div className="flex flex-wrap gap-2 text-xs font-semibold text-slate-700">
                <span className="rounded-full bg-slate-100 px-3 py-1.5">商家：{card.merchant}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1.5">
                  组图 {card.galleryImageCount} 张
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1.5">
                  规格：
                  {card.extractedAttributes.length > 0
                    ? card.extractedAttributes.join('、') + '已提取'
                    : '未识别'}
                </span>
                <span
                  className={`rounded-full px-3 py-1.5 ${
                    card.confidence.source === 'llm'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {card.confidence.source === 'llm' ? 'LLM 归一化' : '启发式归一化'} ·{' '}
                  {(card.confidence.overall * 100).toFixed(0)}%
                </span>
              </div>
              <a
                href={card.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded-full border px-4 py-2 text-xs font-semibold"
              >
                打开来源页
              </a>
              {card.confidence.notes ? (
                <p className="text-xs leading-5 text-amber-700">{card.confidence.notes}</p>
              ) : null}
            </div>
          </article>

          <div className="space-y-5">
            <div>
              <p className="text-sm font-semibold text-slate-500">组图预览（前 12 张）</p>
              <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-4">
                {card.galleryImages.slice(0, 12).map((url) => (
                  <button
                    key={url}
                    type="button"
                    onClick={() => setZoomImage(url)}
                    className="group relative overflow-hidden rounded-lg border"
                    title="点击放大"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt=""
                      className="h-24 w-full object-cover transition group-hover:scale-110"
                    />
                    <span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-xs font-semibold text-white group-hover:flex">
                      🔍
                    </span>
                  </button>
                ))}
                {card.galleryImages.length === 0 ? (
                  <p className="col-span-full text-sm text-slate-400">未抓到组图</p>
                ) : null}
              </div>
            </div>

            {raw ? (
              <details className="rounded-2xl border bg-slate-50 p-4 text-sm">
                <summary className="cursor-pointer font-semibold text-slate-700">
                  原始抓取信号（用于调试 / 反查 LLM 输入）
                </summary>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <RawField label="code" value={raw.code} />
                  <RawField label="来源 URL" value={raw.sourceUrl} mono />
                  <RawField label="标题候选" value={raw.titleCandidates.join(' | ')} />
                  <RawField label="价格候选" value={raw.priceCandidates.join(' / ')} />
                  <RawField label="商家候选" value={raw.merchantCandidates.join(' / ') || '—'} />
                  <RawField label="品牌候选" value={raw.brandCandidates.join(' / ') || '—'} />
                  <RawField label="型号候选" value={raw.modelCandidates.join(' / ') || '—'} />
                  <RawField label="图片总数" value={String(raw.imageCount)} />
                  <RawField
                    label="Playwright 渲染"
                    value={raw.screenshotPresent ? '✅ 已渲染 + 整页截图已送 LLM' : '— 未启用或失败'}
                  />
                </div>
                {raw.renderedBodyText ? (
                  <div className="mt-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      渲染后页面文本（前 1200 字 · 来自 Playwright）
                    </p>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border bg-white p-3 text-xs leading-5 text-slate-700">
                      {raw.renderedBodyText}
                    </pre>
                  </div>
                ) : null}
                {raw.descriptionBlocks.length > 0 ? (
                  <div className="mt-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      描述段落
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-slate-600">
                      {raw.descriptionBlocks.map((block, i) => (
                        <li key={i}>{block}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      {zoomImage ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setZoomImage(null)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setZoomImage(null);
            }}
            className="absolute right-6 top-6 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
          >
            关闭 ✕
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomImage}
            alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] cursor-zoom-out object-contain"
          />
          <a
            href={zoomImage}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-4 py-2 text-xs font-mono text-white hover:bg-white/20"
          >
            原图新窗口打开 ↗
          </a>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function RawField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border bg-white p-3">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 break-all text-sm text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </div>
    </div>
  );
}
