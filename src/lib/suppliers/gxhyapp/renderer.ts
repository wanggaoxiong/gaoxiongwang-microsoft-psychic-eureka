import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';

/**
 * 用 Playwright 把 gxhyapp 详情页跑成"用户已看到"的状态：
 *  - 启动无头 Chromium，模拟移动端 viewport（页面是移动端 H5）
 *  - 等 SPA 拿到接口数据、价格/商家文本出现
 *  - 抓两样东西：1) 整页截图 PNG（base64 data URL，喂多模态模型）
 *                 2) document.body.innerText（已 hydrate 的纯文本，给 LLM 当文字信号）
 */
export type RenderedDetail = {
  /** 渲染后整页 innerText，已经包含 ¥690 / 商家名 / 型号 等 SPA 注入的内容 */
  bodyText: string;
  /** 整页截图 data URL（image/png;base64,...），可直接作为 LLM input_image */
  screenshotDataUrl: string;
  /** 截图字节数（用于决策是否压缩或截断） */
  screenshotBytes: number;
};

const VIEWPORT = { width: 414, height: 896 } as const;
const NAV_TIMEOUT_MS = 25_000;
const HYDRATION_WAIT_MS = 3500;

/**
 * 全局浏览器单例：第一次 render 创建，进程退出时关闭。
 * Next.js 开发服务器是同一 Node 进程长驻，可以复用 browser 避免每次启动 ~1s。
 */
let cachedBrowserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!cachedBrowserPromise) {
    cachedBrowserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    // 进程退出时清理（防止僵尸 chromium）
    const close = async () => {
      try {
        const b = await cachedBrowserPromise;
        await b?.close();
      } catch {
        /* ignore */
      }
    };
    process.once('exit', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
  return cachedBrowserPromise;
}

export async function renderGxhyappDetail(url: string): Promise<RenderedDetail> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2,
    locale: 'zh-CN'
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // 先等价格文本出现（成功路径），最多 8s；失败就退回固定 hydration 等待
    await Promise.race([
      page
        .waitForFunction(
          () => /[¥￥]\s*\d/.test(document.body?.innerText ?? ''),
          undefined,
          { timeout: 8000 }
        )
        .catch(() => undefined),
      page.waitForTimeout(HYDRATION_WAIT_MS)
    ]);
    // 再让所有图片/字体最后一波渲染稳定
    await page
      .waitForLoadState('networkidle', { timeout: 5000 })
      .catch(() => undefined);

    const bodyText = (await page.evaluate(() => document.body?.innerText ?? '')).trim();

    // 整页截图原始 PNG（可能几 MB）
    const rawBuffer = await page.screenshot({
      type: 'png',
      fullPage: true,
      timeout: 15_000
    });

    // 用 sharp 压缩：最大宽 1024 + JPEG q70，避免 base64 超过 Azure Responses API 限制
    const jpegBuffer = await sharp(rawBuffer)
      .resize({ width: 1024, withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();

    return {
      bodyText: bodyText.slice(0, 6000),
      screenshotDataUrl: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`,
      screenshotBytes: jpegBuffer.byteLength
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
