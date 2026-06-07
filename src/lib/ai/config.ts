export type AiProvider = 'azure-foundry';

export type AiConfig = {
  provider: AiProvider;
  endpoint: string;
  apiKey: string;
  modelPreset: string; // 'gpt-5.4' | 'gpt-5.4-mini' | ... | 'custom'
  customModel: string;
  /** 场景化模型：留空 = 跟随主模型。 */
  searchModelPreset?: string; // '' | 'gpt-5.4' | ... | 'custom'
  searchCustomModel?: string;
};

export const AI_MODEL_PRESETS: Array<{ value: string; label: string; recommended?: boolean }> = [
  { value: 'gpt-5.4', label: 'gpt-5.4 · 多模态推荐', recommended: true },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini · 成本更低' },
  { value: 'gpt-5-mini', label: 'gpt-5-mini' },
  { value: 'model-router', label: 'model-router · 自动路由' },
  { value: 'custom', label: '自定义 deployment 名' }
];

// 与历史 playground 共用同一个 key，保证向后兼容
const STORAGE_KEY = 'gxhyapp_azure_config_v1';

const DEFAULT: AiConfig = {
  provider: 'azure-foundry',
  endpoint: '',
  apiKey: '',
  modelPreset: 'gpt-5.4',
  customModel: '',
  searchModelPreset: '',
  searchCustomModel: ''
};

export function loadAiConfig(): AiConfig {
  if (typeof window === 'undefined') return DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      provider: 'azure-foundry',
      endpoint: parsed.endpoint ?? '',
      apiKey: parsed.apiKey ?? '',
      modelPreset: parsed.modelPreset ?? 'gpt-5.4',
      customModel: parsed.customModel ?? '',
      searchModelPreset: parsed.searchModelPreset ?? '',
      searchCustomModel: parsed.searchCustomModel ?? ''
    };
  } catch {
    return DEFAULT;
  }
}

export function saveAiConfig(cfg: AiConfig): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearAiConfig(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function getEffectiveModel(cfg: AiConfig): string {
  return cfg.modelPreset === 'custom' ? cfg.customModel.trim() : cfg.modelPreset;
}

/**
 * 取「AI 检索 / 筛选」场景的模型。未单独配置时回退主模型。
 * 适合检索这种纯文本任务，可单独选成本更低的 gpt-5.4-mini。
 */
export function getEffectiveSearchModel(cfg: AiConfig): string {
  const preset = cfg.searchModelPreset || '';
  if (!preset) return getEffectiveModel(cfg);
  return preset === 'custom' ? (cfg.searchCustomModel || '').trim() : preset;
}

export function isAiConfigured(cfg: AiConfig): boolean {
  return !!(cfg.endpoint && cfg.apiKey && getEffectiveModel(cfg));
}
