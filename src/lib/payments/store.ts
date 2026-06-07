import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * 收款方式配置。
 *
 * 设计原则（安全/防泄露）：
 * - 这里只存「方式名称/标签」（如 PayPal、银行转账、Wise）给 AI 参考，让它能自然地告诉客户
 *   「我们支持 PayPal / 银行转账」。
 * - 真实账号/收款详情（PayPal 邮箱、银行卡号等）放在 `detail` 字段，**仅人工可见**（左侧亮灯
 *   时给销售看，方便一键复制），**绝不**注入 AI 提示词、绝不让 AI 自动发给客户。
 * - 收款/PI 永远走人工：S7 进入付款环节会自动暂停 AI 并在左侧亮灯提醒。
 */
export const paymentMethodSchema = z.object({
  id: z.string().min(1),
  /** 给 AI 和客户看的方式名称，如 "PayPal" / "银行转账" / "Wise" */
  label: z.string().min(1).max(40),
  /** 是否启用（关掉的方式 AI 不会提及） */
  enabled: z.boolean().default(true),
  /** 真实账号/收款详情：仅人工可见，绝不进 AI、绝不自动发客户 */
  detail: z.string().max(2000).optional(),
  /** 仅人工可见的备注（如手续费/到账时间提醒） */
  note: z.string().max(500).optional()
});

export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const paymentConfigSchema = z.object({
  methods: z.array(paymentMethodSchema).default([])
});

export type PaymentConfig = z.infer<typeof paymentConfigSchema>;

const STORE_PATH = path.join(process.cwd(), 'data', 'payment-methods.json');

const defaultPaymentConfig: PaymentConfig = {
  methods: [
    { id: 'paypal', label: 'PayPal', enabled: true },
    { id: 'bank-transfer', label: '银行转账 / T-T', enabled: true },
    { id: 'wise', label: 'Wise', enabled: false }
  ]
};

let writeQueue: Promise<void> = Promise.resolve();

async function ensureFile(): Promise<void> {
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(defaultPaymentConfig, null, 2), 'utf-8');
  }
}

export async function loadPaymentConfig(): Promise<PaymentConfig> {
  await ensureFile();
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    return paymentConfigSchema.parse(JSON.parse(raw));
  } catch {
    return paymentConfigSchema.parse(defaultPaymentConfig);
  }
}

export async function savePaymentConfig(next: PaymentConfig): Promise<PaymentConfig> {
  const safe = paymentConfigSchema.parse(next);
  writeQueue = writeQueue.then(async () => {
    await ensureFile();
    const tmp = `${STORE_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(safe, null, 2), 'utf-8');
    await fs.rename(tmp, STORE_PATH);
  });
  await writeQueue;
  return safe;
}

/**
 * 给 AI 看的「可提及的收款方式名称」列表（只含启用的 label，绝不含真实账号 detail）。
 * 例：["PayPal", "银行转账 / T-T"]
 */
export async function listPaymentMethodLabelsForAi(): Promise<string[]> {
  const cfg = await loadPaymentConfig();
  return cfg.methods.filter((m) => m.enabled).map((m) => m.label);
}
