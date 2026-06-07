/**
 * 多语言定义：商品翻译用。
 * 'zh' 是原始语言（提取时直接输出中文），其它语言走按需翻译 + 落盘缓存。
 */
export type LangCode = 'zh' | 'en' | 'de' | 'fr' | 'it' | 'ja' | 'ko';

export const SUPPORTED_LANGS: ReadonlyArray<{
  code: LangCode;
  label: string;
  englishName: string;
  flag: string;
}> = [
  { code: 'zh', label: '中文', englishName: 'Chinese (Simplified)', flag: '🇨🇳' },
  { code: 'en', label: 'EN', englishName: 'English', flag: '🇬🇧' },
  { code: 'de', label: 'DE', englishName: 'German', flag: '🇩🇪' },
  { code: 'fr', label: 'FR', englishName: 'French', flag: '🇫🇷' },
  { code: 'it', label: 'IT', englishName: 'Italian', flag: '🇮🇹' },
  { code: 'ja', label: 'JA', englishName: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', label: 'KO', englishName: 'Korean', flag: '🇰🇷' }
];

export const DEFAULT_LANG: LangCode = 'zh';

export function isLangCode(x: string): x is LangCode {
  return SUPPORTED_LANGS.some((l) => l.code === x);
}

/** 商品的可翻译字段子集（不翻 brand / model / skuCode / price / sourceUrl 等） */
export type LocalizedFields = {
  title?: string;
  series?: string;
  categoryPath?: string[];
  gender?: string;
  colors?: string[];
  sizes?: string[];
  materials?: string[];
  targetAudience?: string;
  descriptionBullets?: string[];
  attributes?: string[];
  stockText?: string;
};

/** Drawer 内固定 UI 文案的多语言字典 */
export type UiLabels = {
  category: string;
  sku: string;
  colors: string;
  sizes: string;
  materials: string;
  audience: string;
  bullets: string;
  attributes: string;
  llmFeedback: string;
  source: string;
  addedAt: string;
  sendToWhatsApp: string;
  inStock: string;
  outOfStock: string;
  llm: string;
  heuristic: string;
  images: string;
  close: string;
  delete: string;
  deleting: string;
  empty: string;
};

export const UI_LABELS: Record<LangCode, UiLabels> = {
  zh: {
    category: '品类', sku: '商家货号', colors: '颜色', sizes: '尺寸', materials: '材质',
    audience: '适用场景', bullets: '营销卖点', attributes: '其他规格', llmFeedback: 'LLM 反馈',
    source: '来源', addedAt: '添加于', sendToWhatsApp: '发送到 WhatsApp 会话',
    inStock: '✓ 有货', outOfStock: '× 缺货', llm: 'LLM', heuristic: '启发式',
    images: '张图', close: '关闭', delete: '删除', deleting: '删除中…', empty: '—'
  },
  en: {
    category: 'Category', sku: 'Merchant SKU', colors: 'Colors', sizes: 'Sizes', materials: 'Materials',
    audience: 'Best for', bullets: 'Highlights', attributes: 'Other specs', llmFeedback: 'LLM notes',
    source: 'Source', addedAt: 'Added', sendToWhatsApp: 'Send to WhatsApp',
    inStock: '✓ In stock', outOfStock: '× Out of stock', llm: 'LLM', heuristic: 'Heuristic',
    images: 'imgs', close: 'Close', delete: 'Delete', deleting: 'Deleting…', empty: '—'
  },
  de: {
    category: 'Kategorie', sku: 'Händler-SKU', colors: 'Farben', sizes: 'Größen', materials: 'Material',
    audience: 'Anlass', bullets: 'Highlights', attributes: 'Weitere Specs', llmFeedback: 'LLM-Hinweis',
    source: 'Quelle', addedAt: 'Hinzugefügt', sendToWhatsApp: 'An WhatsApp senden',
    inStock: '✓ Auf Lager', outOfStock: '× Ausverkauft', llm: 'LLM', heuristic: 'Heuristik',
    images: 'Bilder', close: 'Schließen', delete: 'Löschen', deleting: 'Lösche…', empty: '—'
  },
  fr: {
    category: 'Catégorie', sku: 'SKU marchand', colors: 'Couleurs', sizes: 'Tailles', materials: 'Matériaux',
    audience: 'Occasions', bullets: 'Points forts', attributes: 'Autres specs', llmFeedback: 'Note LLM',
    source: 'Source', addedAt: 'Ajouté le', sendToWhatsApp: 'Envoyer à WhatsApp',
    inStock: '✓ En stock', outOfStock: '× Rupture', llm: 'LLM', heuristic: 'Heuristique',
    images: 'images', close: 'Fermer', delete: 'Supprimer', deleting: 'Suppression…', empty: '—'
  },
  it: {
    category: 'Categoria', sku: 'SKU venditore', colors: 'Colori', sizes: 'Misure', materials: 'Materiali',
    audience: 'Adatto a', bullets: 'Punti forti', attributes: 'Altre specifiche', llmFeedback: 'Nota LLM',
    source: 'Fonte', addedAt: 'Aggiunto', sendToWhatsApp: 'Invia a WhatsApp',
    inStock: '✓ Disponibile', outOfStock: '× Esaurito', llm: 'LLM', heuristic: 'Euristica',
    images: 'foto', close: 'Chiudi', delete: 'Elimina', deleting: 'Eliminazione…', empty: '—'
  },
  ja: {
    category: 'カテゴリ', sku: '販売者SKU', colors: 'カラー', sizes: 'サイズ', materials: '素材',
    audience: 'シーン', bullets: 'セールスポイント', attributes: 'その他仕様', llmFeedback: 'LLMメモ',
    source: 'ソース', addedAt: '追加日', sendToWhatsApp: 'WhatsAppへ送信',
    inStock: '✓ 在庫あり', outOfStock: '× 在庫切れ', llm: 'LLM', heuristic: 'ヒューリスティック',
    images: '枚', close: '閉じる', delete: '削除', deleting: '削除中…', empty: '—'
  },
  ko: {
    category: '카테고리', sku: '판매자 SKU', colors: '컬러', sizes: '사이즈', materials: '소재',
    audience: '추천 상황', bullets: '핵심 포인트', attributes: '기타 사양', llmFeedback: 'LLM 메모',
    source: '출처', addedAt: '추가일', sendToWhatsApp: 'WhatsApp로 전송',
    inStock: '✓ 재고 있음', outOfStock: '× 품절', llm: 'LLM', heuristic: '휴리스틱',
    images: '장', close: '닫기', delete: '삭제', deleting: '삭제 중…', empty: '—'
  }
};
