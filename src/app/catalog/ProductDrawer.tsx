'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Badge, Divider } from '@/lib/ui/primitives';
import type { CatalogProduct } from '@/lib/catalog/repo';
import { loadAiConfig, getEffectiveModel, isAiConfigured } from '@/lib/ai/config';
import { SUPPORTED_LANGS, DEFAULT_LANG, UI_LABELS, type LangCode, type LocalizedFields } from '@/lib/i18n/languages';

function azurePayload() {
  const cfg = loadAiConfig();
  if (!isAiConfigured(cfg)) return undefined;
  return { endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: getEffectiveModel(cfg) };
}

export function ProductDrawer({
  product,
  onClose,
  onDelete
}: {
  product: CatalogProduct | null;
  onClose: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [activeImage, setActiveImage] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [showConvPick, setShowConvPick] = useState(false);
  const [lang, setLang] = useState<LangCode>(DEFAULT_LANG);
  const [localProduct, setLocalProduct] = useState<CatalogProduct | null>(product);
  const [translating, setTranslating] = useState<LangCode | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);

  useEffect(() => {
    setActiveImage(0);
    setLang(DEFAULT_LANG);
    setLocalProduct(product);
    setTranslateError(null);
    // 切换商品时，重置二级面板/弹层状态，避免上一商品的 picker 残留
    setShowConvPick(false);
  }, [product?.id]);

  useEffect(() => {
    if (!product) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // ESC 优先关闭最上层的 picker，再次按 ESC 才关闭 drawer
        if (showConvPick) {
          setShowConvPick(false);
        } else {
          onClose();
        }
        return;
      }
      // 翻图快捷键：picker 打开时不要触发
      if (showConvPick) return;
      if (e.key === 'ArrowLeft') setActiveImage((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight')
        setActiveImage((i) => {
          const len = (product?.galleryImages.length || 1);
          return Math.min(len - 1, i + 1);
        });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [product, onClose, showConvPick]);

  if (!product) return null;
  // 以 localProduct 为主渲染（翻译后的更新同步到 UI）
  const p = localProduct ?? product;
  const loc: LocalizedFields | undefined = lang === 'zh' ? undefined : p.localizations?.[lang];
  const L = UI_LABELS[lang];
  const T = {
    title: loc?.title ?? p.title,
    series: loc?.series ?? p.series,
    categoryPath: loc?.categoryPath ?? p.categoryPath,
    gender: loc?.gender ?? p.gender,
    colors: loc?.colors ?? p.colors,
    sizes: loc?.sizes ?? p.sizes,
    materials: loc?.materials ?? p.materials,
    targetAudience: loc?.targetAudience ?? p.targetAudience,
    descriptionBullets: loc?.descriptionBullets ?? p.descriptionBullets,
    attributes: loc?.attributes ?? p.attributes,
    stockText: loc?.stockText ?? p.stockText
  };

  async function handleLangClick(next: LangCode) {
    if (next === lang) return;
    setTranslateError(null);
    // zh 或已缓存：直接切
    if (next === 'zh' || p.localizations?.[next]) {
      setLang(next);
      return;
    }
    setTranslating(next);
    try {
      const res = await fetch(`/api/catalog/${p.id}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: next, azure: azurePayload() })
      });
      const json = await res.json();
      if (!res.ok) {
        setTranslateError(json?.error ?? `翻译失败 (${res.status})`);
        return;
      }
      setLocalProduct(json as CatalogProduct);
      setLang(next);
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : '翻译请求失败');
    } finally {
      setTranslating(null);
    }
  }

  async function handleDelete() {
    if (!product || !confirm(`确认删除「${product.title}」？`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/catalog/${product.id}`, { method: 'DELETE' });
      onDelete();
    } finally {
      setDeleting(false);
    }
  }

  const images = product.galleryImages.length > 0 ? product.galleryImages : [product.mainImage];
  const mainImg = images[activeImage] || product.mainImage;
  const canPrev = activeImage > 0;
  const canNext = activeImage < images.length - 1;
  const goPrev = () => canPrev && setActiveImage((i) => i - 1);
  const goNext = () => canNext && setActiveImage((i) => i + 1);

  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <aside
        className="flex h-screen w-[480px] flex-col overflow-y-auto border-l border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
          <p className="font-mono text-xs text-zinc-500">{product.sourceCode}</p>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {L.close}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? L.deleting : L.delete}
            </Button>
          </div>
        </div>

        {/* gallery */}
        <div className="p-5">
          <div className="relative aspect-square overflow-hidden rounded-lg bg-zinc-100">
            {mainImg ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mainImg} alt="" className="h-full w-full object-cover" />
            ) : null}
            {images.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={!canPrev}
                  aria-label="上一张"
                  className="absolute left-2 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-white/85 text-zinc-700 shadow-md backdrop-blur transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ‹
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canNext}
                  aria-label="下一张"
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-white/85 text-zinc-700 shadow-md backdrop-blur transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ›
                </button>
                <div className="absolute bottom-2 right-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  {activeImage + 1} / {images.length}
                </div>
              </>
            ) : null}
          </div>
          {images.length > 1 ? (
            <div className="mt-2 flex gap-1.5 overflow-x-auto">
              {images.map((url, i) => (
                <button
                  type="button"
                  key={url + i}
                  onClick={() => setActiveImage(i)}
                  className={`h-12 w-12 shrink-0 overflow-hidden rounded border-2 ${
                    i === activeImage ? 'border-[#5E6AD2]' : 'border-transparent'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* info */}
        <div className="space-y-4 px-5 pb-5">
          {/* 语言切换 */}
          <div className="flex flex-wrap items-center gap-1">
            {SUPPORTED_LANGS.map((l) => {
              const active = lang === l.code;
              const hasCache = l.code === 'zh' || !!p.localizations?.[l.code];
              const busy = translating === l.code;
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => handleLangClick(l.code)}
                  disabled={busy}
                  title={hasCache ? l.englishName : `${l.englishName} (按需翻译)`}
                  className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition ${
                    active
                      ? 'bg-[#5E6AD2] text-white'
                      : hasCache
                        ? 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                        : 'border border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-400'
                  } ${busy ? 'opacity-60' : ''}`}
                >
                  <span>{l.flag}</span>
                  <span>{l.label}</span>
                  {busy ? <span className="animate-pulse">…</span> : null}
                </button>
              );
            })}
          </div>
          {translateError ? (
            <p className="-mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{translateError}</p>
          ) : null}

          <div>
            <h2 className="text-base font-semibold text-zinc-950">{T.title}</h2>
            <p className="mt-1 text-xs text-zinc-500">
              {[p.brand, T.series, p.model].filter(Boolean).join(' · ')}
            </p>
          </div>

          <p className="text-2xl font-bold text-[#5E6AD2]">
            {p.price}
            {p.currency && !new RegExp(`^(${p.currency}|[¥￥$€£₩])`, 'i').test(p.price) ? (
              <span className="ml-2 text-xs font-normal text-zinc-500">{p.currency}</span>
            ) : null}
          </p>

          <div className="flex flex-wrap gap-1.5">
            <Badge>{p.merchant}</Badge>
            {T.gender && T.gender !== '未确认' ? (
              <Badge tone="muted">{T.gender}</Badge>
            ) : null}
            {typeof p.inStock === 'boolean' ? (
              <Badge tone={p.inStock ? 'success' : 'warning'} title={p.stockText ?? undefined}>
                {p.inStock ? L.inStock : L.outOfStock}
              </Badge>
            ) : null}
            <Badge tone="muted">{p.galleryImages.length} {L.images}</Badge>
            <Badge
              tone={p.confidenceSource === 'llm' ? 'accent' : 'warning'}
              title={p.confidenceNotes ?? (p.confidenceSource === 'llm' ? 'LLM 提取' : '启发式提取')}
            >
              {p.confidenceSource === 'llm' ? L.llm : L.heuristic} ·{' '}
              {(p.confidence * 100).toFixed(0)}%
            </Badge>
          </div>

          <Divider />

          <Section title={L.category}>
            <p className="text-sm text-zinc-700">
              {T.categoryPath.join(' / ') || L.empty}
            </p>
          </Section>

          {p.skuCode ? (
            <Section title={L.sku}>
              <p className="font-mono text-sm text-zinc-700">{p.skuCode}</p>
            </Section>
          ) : null}

          {T.colors?.length ? (
            <Section title={L.colors}>
              <div className="flex flex-wrap gap-1">
                {T.colors.map((c) => (
                  <Badge tone="muted" key={c}>
                    {c}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}

          {T.sizes?.length ? (
            <Section title={L.sizes}>
              <div className="flex flex-wrap gap-1">
                {T.sizes.map((s) => (
                  <Badge tone="muted" key={s}>
                    {s}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}

          {T.materials?.length ? (
            <Section title={L.materials}>
              <div className="flex flex-wrap gap-1">
                {T.materials.map((m) => (
                  <Badge tone="muted" key={m}>
                    {m}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}

          {T.targetAudience ? (
            <Section title={L.audience}>
              <p className="text-sm text-zinc-700">{T.targetAudience}</p>
            </Section>
          ) : null}

          {T.descriptionBullets?.length ? (
            <Section title={L.bullets}>
              <ul className="list-disc space-y-1 pl-4 text-sm leading-5 text-zinc-700">
                {T.descriptionBullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title={L.attributes}>
            {T.attributes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {T.attributes.map((a) => (
                  <Badge tone="muted" key={a}>
                    {a}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">{L.empty}</p>
            )}
          </Section>

          {p.confidenceNotes ? (
            <Section title={L.llmFeedback}>
              <p className="rounded-md bg-amber-50 p-2 text-xs leading-5 text-amber-700">
                {p.confidenceNotes}
              </p>
            </Section>
          ) : null}

          <Section title={L.source}>
            <a
              href={p.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="break-all text-xs text-[#5E6AD2] hover:underline"
            >
              {p.sourceUrl}
            </a>
            <p className="mt-1 text-[11px] text-zinc-400">
              {L.addedAt} {new Date(p.createdAt).toLocaleString()}
            </p>
          </Section>

          <Divider />

          {/* WhatsApp 发送 */}
          <Button
            variant="primary"
            className="w-full"
            onClick={() => setShowConvPick(true)}
          >
            {L.sendToWhatsApp}
          </Button>
        </div>
      </aside>
      {showConvPick ? (
        <ConversationPicker
          onClose={() => setShowConvPick(false)}
          onPick={(convId) => {
            setShowConvPick(false);
            onClose();
            router.push(`/inbox?conv=${convId}&product=${product.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function ConversationPicker({
  onClose,
  onPick
}: {
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [convs, setConvs] = useState<
    Array<{ id: string; name?: string; lastMessage?: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch('/api/wa/conversations')
      .then((r) => r.json())
      .then((j) => setConvs(j.conversations ?? []))
      .finally(() => setLoading(false));
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[400px] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-950">
          选择会话发送
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <p className="px-4 py-8 text-center text-xs text-zinc-400">加载中…</p>
          ) : convs.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-zinc-400">还没有会话</p>
          ) : (
            convs.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => onPick(c.id)}
                className="block w-full border-b border-zinc-100 px-4 py-3 text-left hover:bg-zinc-50"
              >
                <p className="text-sm font-medium text-zinc-950">{c.name || c.id}</p>
                <p className="line-clamp-1 text-xs text-zinc-500">{c.lastMessage || '—'}</p>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
        {title}
      </p>
      {children}
    </div>
  );
}
