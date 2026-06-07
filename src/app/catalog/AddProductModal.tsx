'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Select, Textarea, Label, Card, Badge } from '@/lib/ui/primitives';
import type { CatalogProduct } from '@/lib/catalog/repo';

const DEFAULT_INPUT = 'https://mall.gxhyapp.com/market/web/detailIndex?marketCode=gz&code=1190184416';
const DEFAULT_MAIN_IMAGE =
  'https://product.aliyizhan.com/person/7f0e2f3a4e804e93a68dae625167af7a/c6d984c14c1f456e8e183444586f234e/0.jpg';
const AZURE_CONFIG_KEY = 'gxhyapp_azure_config_v1';

type AzureConfig = {
  endpoint: string;
  apiKey: string;
  modelPreset: string;
  customModel: string;
};

type ScrapeResponse = {
  card: {
    mainImage: string;
    title: string;
    brand: string;
    series: string;
    model: string;
    skuCode: string;
    categoryPath: string[];
    price: string;
    merchant: string;
    galleryImageCount: number;
    extractedAttributes: string[];
    sourceUrl: string;
    galleryImages: string[];
    gender: string;
    colors: string[];
    sizes: string[];
    materials: string[];
    targetAudience: string;
    descriptionBullets: string[];
    searchKeywords?: string[];
    useCase?: string[];
    bestForCustomerType?: string[];
    currency?: string;
    inStock?: boolean;
    stockText?: string;
    confidence: { overall: number; source: 'llm' | 'heuristic'; notes?: string };
  };
  raw: { code: string; sourceUrl: string };
};

function readStoredConfig(): AzureConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AZURE_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getSelectedModel(c: AzureConfig | null): string {
  if (!c) return '';
  return c.modelPreset === 'custom' ? c.customModel.trim() : c.modelPreset;
}

export function AddProductModal({
  open,
  onClose,
  onAdded
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (product: CatalogProduct) => void;
}) {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [mainImageUrl, setMainImageUrl] = useState(DEFAULT_MAIN_IMAGE);
  const [extraText, setExtraText] = useState('');
  const [useRenderer, setUseRenderer] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ScrapeResponse | null>(null);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setError(null);
    }
  }, [open]);

  async function runScrape() {
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const azureConfig = readStoredConfig();
      const selectedModel = getSelectedModel(azureConfig);
      const ready = azureConfig && azureConfig.endpoint && azureConfig.apiKey && selectedModel;

      const base = /^https?:\/\//.test(input.trim())
        ? { url: input.trim() }
        : { code: input.trim() };
      const body: Record<string, unknown> = { ...base, useRenderer };
      if (mainImageUrl.trim()) body.mainImageUrl = mainImageUrl.trim();
      if (extraText.trim()) body.extraText = extraText.trim();
      if (ready) {
        body.azure = {
          endpoint: azureConfig!.endpoint,
          apiKey: azureConfig!.apiKey,
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
      setPreview(json as ScrapeResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : '抓取失败');
    } finally {
      setLoading(false);
    }
  }

  async function saveToCatalog() {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const { card, raw } = preview;
      const res = await fetch('/api/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'gxhyapp',
          sourceCode: raw.code,
          sourceUrl: card.sourceUrl,
          mainImage: card.mainImage,
          galleryImages: card.galleryImages,
          title: card.title,
          brand: card.brand,
          series: card.series,
          model: card.model,
          skuCode: card.skuCode,
          categoryPath: card.categoryPath,
          price: card.price,
          merchant: card.merchant,
          attributes: card.extractedAttributes,
          gender: card.gender,
          colors: card.colors,
          sizes: card.sizes,
          materials: card.materials,
          targetAudience: card.targetAudience,
          descriptionBullets: card.descriptionBullets,
          searchKeywords: card.searchKeywords,
          useCase: card.useCase,
          bestForCustomerType: card.bestForCustomerType,
          currency: card.currency,
          inStock: card.inStock,
          stockText: card.stockText,
          localizations: {
            zh: {
              title: card.title,
              series: card.series,
              categoryPath: card.categoryPath,
              gender: card.gender,
              colors: card.colors,
              sizes: card.sizes,
              materials: card.materials,
              targetAudience: card.targetAudience,
              descriptionBullets: card.descriptionBullets,
              attributes: card.extractedAttributes,
              stockText: card.stockText
            }
          },
          confidence: card.confidence.overall,
          confidenceSource: card.confidence.source,
          confidenceNotes: card.confidence.notes
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      onAdded(json as CatalogProduct);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const card = preview?.card;
  const conf = card?.confidence;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="mt-12 w-full max-w-3xl rounded-xl border border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">添加商品</h2>
            <p className="text-xs text-zinc-500">从 gxhyapp 详情页抓取 → 归一化 → 加入 Catalog</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>

        {/* body */}
        <div className="grid max-h-[70vh] grid-cols-1 gap-5 overflow-y-auto p-5 md:grid-cols-2">
          {/* 输入 */}
          <div className="space-y-3">
            <div>
              <Label>详情页 URL 或 code</Label>
              <Input
                className="mt-1"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="https://mall.gxhyapp.com/..."
              />
            </div>
            <div>
              <Label>主图链接（可选 · 用于枚举完整组图）</Label>
              <Input
                className="mt-1 font-mono text-xs"
                value={mainImageUrl}
                onChange={(e) => setMainImageUrl(e.target.value)}
                placeholder="https://product.aliyizhan.com/.../0.jpg"
              />
            </div>
            <div>
              <Label>补充文本（可选 · 从页面复制价格/商家/描述）</Label>
              <Textarea
                className="mt-1 font-mono text-xs"
                rows={4}
                value={extraText}
                onChange={(e) => setExtraText(e.target.value)}
                placeholder="¥690&#10;小枣高端包包"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
              <input
                type="checkbox"
                checked={useRenderer}
                onChange={(e) => setUseRenderer(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span>Playwright 渲染 SPA（推荐 · 抓 hydrated 文本 + 整页截图）</span>
            </label>
            <div className="flex gap-2 pt-1">
              <Button
                variant="primary"
                onClick={runScrape}
                disabled={loading || !input.trim()}
              >
                {loading ? '抓取中…' : preview ? '重新抓取' : '抓取预览'}
              </Button>
              {preview ? (
                <Button variant="secondary" onClick={saveToCatalog} disabled={saving}>
                  {saving ? '保存中…' : '加入 Catalog'}
                </Button>
              ) : null}
            </div>
            {error ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            ) : null}
          </div>

          {/* 预览 */}
          <div>
            <Label>预览</Label>
            {card ? (
              <Card className="mt-1 overflow-hidden">
                {card.mainImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.mainImage} alt="" className="h-44 w-full object-cover" />
                ) : (
                  <div className="flex h-44 w-full items-center justify-center bg-zinc-50 text-xs text-zinc-400">
                    无主图
                  </div>
                )}
                <div className="space-y-2 p-3">
                  <p className="text-sm font-semibold text-zinc-900">{card.title}</p>
                  <p className="text-xs text-zinc-500">
                    {[card.brand, card.series, card.model].filter(Boolean).join(' · ')}
                    {card.skuCode ? ` · 货号 ${card.skuCode}` : ''}
                  </p>
                  <p className="text-sm font-semibold text-[#5E6AD2]">{card.price}</p>
                  <div className="flex flex-wrap gap-1">
                    <Badge>{card.merchant}</Badge>
                    {card.gender && card.gender !== '未确认' ? (
                      <Badge tone="muted">{card.gender}</Badge>
                    ) : null}
                    <Badge tone="muted">{card.galleryImageCount} 图</Badge>
                    <Badge tone={conf?.source === 'llm' ? 'accent' : 'warning'}>
                      {conf?.source === 'llm' ? 'LLM' : '启发式'} ·{' '}
                      {((conf?.overall ?? 0) * 100).toFixed(0)}%
                    </Badge>
                  </div>
                  {card.colors?.length ? (
                    <p className="text-xs text-zinc-500">颜色：{card.colors.join('、')}</p>
                  ) : null}
                  {card.sizes?.length ? (
                    <p className="text-xs text-zinc-500">尺寸：{card.sizes.join('、')}</p>
                  ) : null}
                  {card.materials?.length ? (
                    <p className="text-xs text-zinc-500">材质：{card.materials.join('、')}</p>
                  ) : null}
                  {card.targetAudience ? (
                    <p className="text-xs text-zinc-500">场景：{card.targetAudience}</p>
                  ) : null}
                  {card.descriptionBullets?.length ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-zinc-600">
                      {card.descriptionBullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  ) : null}
                  {card.extractedAttributes.length > 0 ? (
                    <p className="text-xs text-zinc-400">
                      其他：{card.extractedAttributes.join('、')}
                    </p>
                  ) : null}
                  {conf?.notes ? (
                    <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-700">
                      {conf.notes}
                    </p>
                  ) : null}
                </div>
              </Card>
            ) : (
              <div className="mt-1 flex h-44 items-center justify-center rounded-md border border-dashed border-zinc-200 text-xs text-zinc-400">
                抓取后预览将出现在这里
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
