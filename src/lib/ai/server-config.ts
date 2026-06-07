import 'server-only';
import { promises as fs } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 服务端持久化的 Azure 配置。
 *
 * 为什么需要它：
 *   - 前端 AI 配置只存 localStorage，浏览器看得到，服务端看不到。
 *   - DRAFT_AUTO / AUTO_SAFE / AUTO_FULL 这些自动响应是 inbound message handler
 *     在服务端 fire-and-forget 触发的，没办法读取浏览器 localStorage。
 *   - 我们也不想强制用户配 .env.local（很多人不会配）。
 *
 * 设计：
 *   - 用户每次在「设置 → AI 模型」点保存，前端额外 POST /api/ai/config，
 *     服务端就把 endpoint/apiKey/model 写到 data/ai-config.json。
 *   - resolveAzure() 的优先级：调用方 override → 环境变量 → 这个文件。
 *
 * 安全：
 *   - 文件只读写在本地 data/ 目录，权限随 OS。
 *   - 不会出现在 git（data/ 通常已在 .gitignore；如果没有，里面本就是机密数据）。
 */

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'ai-config.json');

export type ServerAzureConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
};

/** 读不到 / 不全 / 解析失败 → 返回 null。绝不抛。 */
export function readServerAzureConfigSync(): ServerAzureConfig | null {
  try {
    if (!existsSync(FILE)) return null;
    const raw = readFileSync(FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ServerAzureConfig>;
    const endpoint = (parsed.endpoint || '').trim();
    const apiKey = (parsed.apiKey || '').trim();
    const model = (parsed.model || '').trim();
    if (!endpoint || !apiKey || !model) return null;
    return { endpoint, apiKey, model };
  } catch {
    return null;
  }
}

export async function writeServerAzureConfig(cfg: ServerAzureConfig): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

export async function clearServerAzureConfig(): Promise<void> {
  try {
    await fs.unlink(FILE);
  } catch {
    /* 不存在视为成功 */
  }
}
