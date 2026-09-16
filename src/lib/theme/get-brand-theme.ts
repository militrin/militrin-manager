import { cache } from 'react';
import { withTimeout } from '@/lib/auth/middleware-guard';
import { BrandThemeId, DEFAULT_BRAND_THEME, isBrandThemeId } from './brand-themes';

const THEME_QUERY_TIMEOUT_MS = 2000;
export const BRAND_THEME_CACHE_TAG = 'brand-theme';

function getSupabaseAnonKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
}

/**
 * Tema global da plataforma. Leitura anonima (RLS permite SELECT para anon)
 * com revalidate de 1h -- nao usa sessao autenticada por request, para o
 * root layout nao forcar todas as paginas a Function dinamica.
 */
async function loadBrandTheme(): Promise<BrandThemeId> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const anonKey = getSupabaseAnonKey();
    if (!baseUrl || !anonKey) return DEFAULT_BRAND_THEME;

    const endpoint = `${baseUrl.replace(/\/$/, '')}/rest/v1/platform_settings?id=eq.true&select=brand_theme`;
    const raced = await withTimeout(
      fetch(endpoint, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        next: { revalidate: 3600, tags: [BRAND_THEME_CACHE_TAG] },
      }).then(async (response) => {
        if (!response.ok) return DEFAULT_BRAND_THEME;
        const payload = (await response.json()) as Array<{ brand_theme?: string }> | { brand_theme?: string };
        const row = Array.isArray(payload) ? payload[0] : payload;
        return isBrandThemeId(row?.brand_theme) ? row.brand_theme : DEFAULT_BRAND_THEME;
      }),
      THEME_QUERY_TIMEOUT_MS,
    );
    if (!raced.ok) return DEFAULT_BRAND_THEME;
    return raced.value;
  } catch {
    return DEFAULT_BRAND_THEME;
  }
}

export const getBrandTheme = cache(loadBrandTheme);
