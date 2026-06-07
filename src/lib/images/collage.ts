/**
 * 客户端 canvas 拼图：把若干商品图按布局拼成一张大图，返回 JPEG data URL。
 * 用于「发送商品 → 拼成一张发送」体验，让朋友只接收 1 条图片消息。
 */

function pickLayout(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(n / 4) };
}

function proxify(url: string): string {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  // 同源资源不需要代理
  try {
    const u = new URL(url, window.location.href);
    if (u.origin === window.location.origin) return url;
  } catch {
    return url;
  }
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${url}`));
    img.src = proxify(url);
  });
}

export type CollageOptions = {
  /** 单格目标尺寸（px），默认 600 */
  cell?: number;
  /** 格之间空隙，默认 6 */
  gap?: number;
  /** 背景色，默认白 */
  bg?: string;
  /** JPEG 质量 0~1，默认 0.85 */
  quality?: number;
};

export async function buildCollage(urls: string[], opts: CollageOptions = {}): Promise<string> {
  const list = urls.filter(Boolean);
  if (list.length === 0) throw new Error('no images');
  if (list.length === 1) {
    // 单图直接返回原 url（外层调用方会作为单张图发送）
    return list[0]!;
  }
  const cell = opts.cell ?? 600;
  const gap = opts.gap ?? 6;
  const bg = opts.bg ?? '#ffffff';
  const quality = opts.quality ?? 0.85;

  const { cols, rows } = pickLayout(list.length);
  const W = cols * cell + (cols + 1) * gap;
  const H = rows * cell + (rows + 1) * gap;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unsupported');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 并发加载（最多并发 6）
  const images: (HTMLImageElement | null)[] = [];
  const concurrency = 6;
  for (let i = 0; i < list.length; i += concurrency) {
    const slice = list.slice(i, i + concurrency);
    const loaded = await Promise.all(slice.map((u) => loadImage(u).catch(() => null)));
    images.push(...loaded);
  }

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = gap + c * (cell + gap);
    const y = gap + r * (cell + gap);
    // object-cover：等比缩放裁切到 cell×cell
    const ratio = Math.max(cell / img.width, cell / img.height);
    const dw = img.width * ratio;
    const dh = img.height * ratio;
    const dx = x + (cell - dw) / 2;
    const dy = y + (cell - dh) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cell, cell);
    ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  return canvas.toDataURL('image/jpeg', quality);
}
