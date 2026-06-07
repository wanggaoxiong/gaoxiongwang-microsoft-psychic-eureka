export type WaConfig = {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string;
  webhookVerifyToken?: string;
  displayPhone?: string;
};

const STORAGE_KEY = 'wa_config_v1';

export function loadWaConfig(): WaConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WaConfig) : null;
  } catch {
    return null;
  }
}

export function saveWaConfig(cfg: WaConfig): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearWaConfig(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function isWaConfigured(cfg: WaConfig | null | undefined): cfg is WaConfig {
  return !!(cfg && cfg.phoneNumberId && cfg.accessToken);
}
