import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  defaultPricingStrategy,
  pricingStrategySchema,
  type PricingStrategy
} from './engine';
import { loadPricingStrategy } from './store';

/**
 * 多报价策略「策略集」v1。
 *
 * 设计目标（用户决策）：
 *   - 维持一套通用兜底策略（与旧单策略文件兼容）；
 *   - 额外维护若干带 appliesWhen 选择条件的策略（按客户分层 / 地区 / 品牌 / 数量）；
 *   - 销售或 AI 按当前会话上下文「自动匹配」最贴合的一套来报价。
 *
 * 存储：<repoRoot>/data/pricing-strategies.json
 * 首次加载若文件不存在，则从旧单策略文件 data/pricing-strategy.json 迁移为默认策略。
 */
const BOOK_PATH = path.join(process.cwd(), 'data', 'pricing-strategies.json');

export const strategyBookSchema = z.object({
  /** 至少含一套策略；其一为默认兜底 */
  strategies: z.array(pricingStrategySchema).default([]),
  /** 默认兜底策略 id（匹配不到任何 appliesWhen 时采用） */
  defaultStrategyId: z.string().optional()
});
export type StrategyBook = z.infer<typeof strategyBookSchema>;

let writeQueue: Promise<void> = Promise.resolve();

function withId(s: PricingStrategy, fallbackId: string): PricingStrategy {
  return { ...s, id: s.id || fallbackId };
}

async function migrateFromSingle(): Promise<StrategyBook> {
  // 旧的单策略作为默认兜底，保证升级无缝。
  let base: PricingStrategy;
  try {
    base = await loadPricingStrategy();
  } catch {
    base = pricingStrategySchema.parse(defaultPricingStrategy);
  }
  const def = withId(base, 'default');
  return { strategies: [def], defaultStrategyId: def.id };
}

export async function loadStrategyBook(): Promise<StrategyBook> {
  try {
    const raw = await fs.readFile(BOOK_PATH, 'utf-8');
    const parsed = strategyBookSchema.parse(JSON.parse(raw));
    if (parsed.strategies.length > 0) {
      // 给缺 id 的策略补 id，保证可引用。
      const strategies = parsed.strategies.map((s, i) => withId(s, `strategy-${i + 1}`));
      const defaultStrategyId =
        parsed.defaultStrategyId && strategies.some((s) => s.id === parsed.defaultStrategyId)
          ? parsed.defaultStrategyId
          : strategies[0].id;
      return { strategies, defaultStrategyId };
    }
  } catch {
    /* 文件不存在或损坏 → 走迁移 */
  }
  const migrated = await migrateFromSingle();
  try {
    await fs.mkdir(path.dirname(BOOK_PATH), { recursive: true });
    await fs.writeFile(BOOK_PATH, JSON.stringify(migrated, null, 2), 'utf-8');
  } catch {
    /* 落盘失败不阻塞读取 */
  }
  return migrated;
}

export async function saveStrategyBook(next: StrategyBook): Promise<StrategyBook> {
  const safe = strategyBookSchema.parse({
    strategies: next.strategies.map((s, i) => withId(s, `strategy-${i + 1}`)),
    defaultStrategyId: next.defaultStrategyId
  });
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(BOOK_PATH), { recursive: true });
    const tmp = `${BOOK_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(safe, null, 2), 'utf-8');
    await fs.rename(tmp, BOOK_PATH);
  });
  await writeQueue;
  return safe;
}

export type StrategySelectContext = {
  customerSegment?: string;
  region?: string;
  brand?: string;
  qty?: number;
};

export type StrategyMatch = {
  strategy: PricingStrategy;
  /** 匹配到的具体条件数（越大越精准）；0 = 兜底默认 */
  score: number;
  /** 命中的条件说明，便于在 UI / 话术里解释为什么用这套 */
  matchedOn: string[];
  /** 是否为兜底默认（没有命中任何 appliesWhen） */
  isFallback: boolean;
};

/**
 * 按会话上下文从策略集中挑最贴合的一套。
 * 规则：策略的 appliesWhen 中「显式声明」的每个维度都必须被 ctx 满足，才算候选；
 * 候选里命中的具体维度越多，分越高；并列取靠前。都不命中 → 默认兜底。
 */
export function selectStrategy(
  book: StrategyBook,
  ctx: StrategySelectContext
): StrategyMatch {
  const fallback =
    book.strategies.find((s) => s.id === book.defaultStrategyId) ?? book.strategies[0];

  let best: StrategyMatch | undefined;
  for (const strategy of book.strategies) {
    const w = strategy.appliesWhen;
    if (!w) continue;
    const matchedOn: string[] = [];
    let ok = true;

    if (w.customerSegments && w.customerSegments.length > 0) {
      if (ctx.customerSegment && w.customerSegments.includes(ctx.customerSegment)) {
        matchedOn.push(`分层=${ctx.customerSegment}`);
      } else {
        ok = false;
      }
    }
    if (ok && w.regions && w.regions.length > 0) {
      if (ctx.region && w.regions.includes(ctx.region)) {
        matchedOn.push(`地区=${ctx.region}`);
      } else {
        ok = false;
      }
    }
    if (ok && w.brands && w.brands.length > 0) {
      const b = ctx.brand?.toLowerCase();
      if (b && w.brands.map((x) => x.toLowerCase()).includes(b)) {
        matchedOn.push(`品牌=${ctx.brand}`);
      } else {
        ok = false;
      }
    }
    if (ok && typeof w.minQty === 'number') {
      if (typeof ctx.qty === 'number' && ctx.qty >= w.minQty) {
        matchedOn.push(`数量≥${w.minQty}`);
      } else {
        ok = false;
      }
    }

    if (ok && matchedOn.length > 0) {
      const score = matchedOn.length;
      if (!best || score > best.score) {
        best = { strategy, score, matchedOn, isFallback: false };
      }
    }
  }

  if (best) return best;
  return { strategy: fallback, score: 0, matchedOn: [], isFallback: true };
}
