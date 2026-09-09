import { BRAND_THEMES, DEFAULT_BRAND_THEME } from '../../lib/theme/brand-themes.ts';

export type TicketPassRgb = readonly [number, number, number];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i;
const DEFAULT_ACCENT_HEX = BRAND_THEMES[DEFAULT_BRAND_THEME].swatch;

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function parseCssColorToRgb(value: string, fallback: TicketPassRgb): TicketPassRgb {
  const text = String(value ?? '').trim();
  const hexMatch = text.match(HEX);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex.split('').map((char) => char + char).join('');
    }
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = text.match(RGB);
  if (rgbMatch) {
    return [
      clampByte(Number(rgbMatch[1])),
      clampByte(Number(rgbMatch[2])),
      clampByte(Number(rgbMatch[3])),
    ];
  }

  return fallback;
}

const DEFAULT_ACCENT = parseCssColorToRgb(DEFAULT_ACCENT_HEX, [0, 0, 0]);

function readCssColor(variable: string, fallbackHex: string): TicketPassRgb {
  const fallback = parseCssColorToRgb(fallbackHex, DEFAULT_ACCENT);
  if (typeof document === 'undefined') return fallback;
  const computed = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return parseCssColorToRgb(computed || fallbackHex, fallback);
}

/**
 * Accent do Event Pass = tokens CSS --brand-* ja aplicados em <html data-brand>.
 * Nao ha paleta paralela: PDF/PNG leem as mesmas variaveis da tela.
 */
export function readTicketPassAccent() {
  return {
    accent: readCssColor('--brand-500', DEFAULT_ACCENT_HEX),
    accentSoft: readCssColor('--brand-300', DEFAULT_ACCENT_HEX),
    accentDeep: readCssColor('--brand-600', DEFAULT_ACCENT_HEX),
  };
}

export const TICKET_PASS_NEUTRAL = {
  background: [10, 10, 12] as TicketPassRgb,
  card: [24, 24, 27] as TicketPassRgb,
  text: [250, 250, 250] as TicketPassRgb,
  muted: [161, 161, 170] as TicketPassRgb,
  subtle: [113, 113, 122] as TicketPassRgb,
  white: [255, 255, 255] as TicketPassRgb,
  success: [52, 211, 153] as TicketPassRgb,
};
