import 'server-only';
import axios from 'axios';
import { httpsAgentWithCustomDns } from '@/lib/net/dns-agent';
import { readServerAzureConfigSync } from '@/lib/ai/server-config';

/**
 * Azure OpenAI Responses API 客户端封装，所有 AI 路由共用。
 * - normalizeAzureEndpoint：把用户可能粘到设置里的各种 URL（带 /openai/v1/responses 后缀等）
 *   归一为 https://xxx.openai.azure.com 形式，避免每个路由各自处理。
 * - resolveAzure：优先用前端 override，回退到环境变量；不齐全返回 null。
 * - extractResponseText：把 Responses API 的多形态返回结构归一为单字符串。
 * - callAzureResponses：一次性 POST + 错误归一 + 文本抽取。
 */
export function normalizeAzureEndpoint(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/openai\/responses$/i, '')
    .replace(/\/openai\/v1\/responses$/i, '')
    .replace(/\/openai\/deployments\/[^/]+\/responses$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

export type AzureCfg = { endpoint: string; apiKey: string; model: string };

export function resolveAzure(
  override?: { endpoint?: string; apiKey?: string; model?: string }
): AzureCfg | null {
  // 优先级：调用方 override（前端 POST body 带的）→ 环境变量 → 服务端落盘文件
  // 文件 fallback 的作用：DRAFT_AUTO / AUTO_SAFE / AUTO_FULL 这些后端 inbound
  // 触发的链路读不到浏览器 localStorage，没有它就只能强迫用户配 .env.local。
  const fileCfg = readServerAzureConfigSync();
  const endpoint = normalizeAzureEndpoint(
    override?.endpoint || process.env.AZURE_OPENAI_ENDPOINT || fileCfg?.endpoint || ''
  );
  const apiKey = (
    override?.apiKey || process.env.AZURE_OPENAI_API_KEY || fileCfg?.apiKey || ''
  ).trim();
  const model = (
    override?.model ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    process.env.AZURE_OPENAI_MODEL ||
    fileCfg?.model ||
    'gpt-5.4'
  ).trim();
  if (!endpoint || !apiKey || !model) return null;
  return { endpoint, apiKey, model };
}

export function extractResponseText(data: unknown): string {
  const root = data as
    | { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }
    | undefined;
  if (typeof root?.output_text === 'string' && root.output_text.trim()) return root.output_text.trim();
  const parts: string[] = [];
  if (Array.isArray(root?.output)) {
    for (const item of root!.output!) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') parts.push(part.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * 这些是 Node 网络层瞬时错误：DNS 抖动 / 本地网络断开 / TCP 重置 / 连接超时。
 * 重试通常就能恢复；不重试会让用户看到 `getaddrinfo ENOTFOUND ...` 这种很吓人的提示。
 */
const TRANSIENT_NET_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED', // axios 超时
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH'
]);

function classifyNetworkError(err: unknown): { transient: boolean; friendly: string; code?: string } {
  // axios v1 错误结构：err.code / err.cause?.code
  const anyErr = err as { code?: string; message?: string; cause?: { code?: string } } | undefined;
  const code = anyErr?.code || anyErr?.cause?.code;
  const transient = !!code && TRANSIENT_NET_CODES.has(code);
  let friendly = anyErr?.message || '未知网络错误';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    friendly = 'AI 网络异常：DNS 解析失败（请检查网络/VPN，或稍后重试）';
  } else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    friendly = 'AI 网络异常：请求超时（请稍后重试）';
  } else if (code === 'ECONNRESET' || code === 'EPIPE') {
    friendly = 'AI 网络异常：连接被重置（请稍后重试）';
  } else if (code === 'ECONNREFUSED') {
    friendly = 'AI 网络异常：连接被拒绝（请检查 Endpoint 是否正确）';
  } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    friendly = 'AI 网络异常：无法连接到 Azure（请检查网络）';
  }
  return { transient, friendly, code };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callAzureResponses(
  cfg: AzureCfg,
  prompt: string,
  opts?: { maxOutputTokens?: number; timeoutMs?: number; retries?: number }
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const url = `${cfg.endpoint}/openai/v1/responses`;
  const maxRetries = Math.max(0, opts?.retries ?? 2);

  let lastTransientErr: string | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        url,
        {
          model: cfg.model,
          max_output_tokens: opts?.maxOutputTokens ?? 800,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
        },
        {
          timeout: opts?.timeoutMs ?? 45_000,
          headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
          validateStatus: (s) => s >= 200 && s < 500,
          httpsAgent: httpsAgentWithCustomDns
        }
      );
      if (response.status >= 400 || response.data?.error) {
        const detail = response.data?.error?.message ?? JSON.stringify(response.data).slice(0, 300);
        return { ok: false, status: response.status, error: `AI ${response.status}: ${detail}` };
      }
      const text = extractResponseText(response.data);
      if (!text) return { ok: false, status: 502, error: 'AI 返回为空' };
      return { ok: true, text };
    } catch (err) {
      const info = classifyNetworkError(err);
      if (info.transient && attempt < maxRetries) {
        // 200ms → 500ms 退避，足以躲过 DNS 抖动且不显著拉长用户感知
        await sleep(200 + attempt * 300);
        lastTransientErr = info.friendly;
        continue;
      }
      return { ok: false, status: 0, error: info.friendly };
    }
  }
  // 理论不会走到（循环里要么 return 要么 continue），兜底
  return { ok: false, status: 0, error: lastTransientErr ?? 'AI 调用失败' };
}
