export const BRAND_THEME_IDS = [
  'pink', 'red', 'rose', 'fuchsia', 'purple', 'violet', 'indigo',
  'blue', 'sky', 'cyan', 'teal', 'emerald', 'green', 'lime',
  'yellow', 'amber', 'orange',
] as const;

export type BrandThemeId = (typeof BRAND_THEME_IDS)[number];

export const DEFAULT_BRAND_THEME: BrandThemeId = 'pink';

export const BRAND_THEMES: Record<BrandThemeId, { label: string; swatch: string }> = {
  pink: { label: 'Rosa', swatch: '#ec4899' },
  red: { label: 'Vermelho', swatch: '#ef4444' },
  rose: { label: 'Rosé', swatch: '#f43f5e' },
  fuchsia: { label: 'Fúcsia', swatch: '#d946ef' },
  purple: { label: 'Roxo', swatch: '#a855f7' },
  violet: { label: 'Violeta', swatch: '#8b5cf6' },
  indigo: { label: 'Índigo', swatch: '#6366f1' },
  blue: { label: 'Azul', swatch: '#3b82f6' },
  sky: { label: 'Céu', swatch: '#0ea5e9' },
  cyan: { label: 'Ciano', swatch: '#06b6d4' },
  teal: { label: 'Turquesa', swatch: '#14b8a6' },
  emerald: { label: 'Esmeralda', swatch: '#10b981' },
  green: { label: 'Verde', swatch: '#22c55e' },
  lime: { label: 'Limão', swatch: '#84cc16' },
  yellow: { label: 'Amarelo', swatch: '#eab308' },
  amber: { label: 'Âmbar', swatch: '#f59e0b' },
  orange: { label: 'Laranja', swatch: '#f97316' },
};

export function isBrandThemeId(value: string | null | undefined): value is BrandThemeId {
  return !!value && (BRAND_THEME_IDS as readonly string[]).includes(value);
}
