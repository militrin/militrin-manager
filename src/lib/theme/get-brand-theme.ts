import { cache } from 'react';
import { withTimeout } from '@/lib/auth/middleware-guard';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { BrandThemeId, DEFAULT_BRAND_THEME, isBrandThemeId } from './brand-themes';

const THEME_QUERY_TIMEOUT_MS = 2000;

export const getBrandTheme = cache(async (): Promise<BrandThemeId> => {
  try {
    const supabase = await createServerSupabaseClient();
    const raced = await withTimeout(
      supabase.from('platform_settings').select('brand_theme').eq('id', true).maybeSingle(),
      THEME_QUERY_TIMEOUT_MS,
    );
    if (!raced.ok) return DEFAULT_BRAND_THEME;
    const { data, error } = raced.value;
    if (error || !data) return DEFAULT_BRAND_THEME;
    return isBrandThemeId(data.brand_theme) ? data.brand_theme : DEFAULT_BRAND_THEME;
  } catch {
    return DEFAULT_BRAND_THEME;
  }
});
