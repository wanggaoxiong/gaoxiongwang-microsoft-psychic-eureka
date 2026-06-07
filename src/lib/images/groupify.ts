export type GroupImageOptions = {
  sourceUrls: string[];
  watermarkText?: string;
  layout?: 'grid3x3' | 'grid2x3' | 'single' | 'auto';
};

export async function buildGroupImages(options: GroupImageOptions): Promise<string[]> {
  return options.sourceUrls.slice(0, 9);
}
