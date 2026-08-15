import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { BrandThemeId, DEFAULT_BRAND_THEME, isBrandThemeId } from './brand-themes';

export const getBrandTheme = cache(async (): Promise<BrandThemeId> => {
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from('platform_settings').select('brand_theme').eq('id', true).maybeSingle();
    if (error || !data) return DEFAULT_BRAND_THEME;
    return isBrandThemeId(data.brand_theme) ? data.brand_theme : DEFAULT_BRAND_THEME;
  } catch {
    return DEFAULT_BRAND_THEME;
  }
});
