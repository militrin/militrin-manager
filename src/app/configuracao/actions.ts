'use server';

import { revalidatePath } from 'next/cache';
import { assertPermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { isBrandThemeId } from '@/lib/theme/brand-themes';

export async function updatePlatformThemeAction(theme: string) {
  await assertPermission('settings.manage');

  if (!isBrandThemeId(theme)) {
    return { success: false, message: 'Tema inválido.' };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('set_platform_brand_theme', { p_theme: theme });

  if (error) {
    return { success: false, message: error.message };
  }

  revalidatePath('/', 'layout');
  return { success: true };
}
