'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';

// Nunca aceita sponsorId do client: update_my_sponsor_banner resolve o
// patrocinador sempre por auth.uid() dentro da RPC -- e essa e a garantia
// real (nao so de UI) de que um patrocinador jamais altera o banner de
// outro, mesmo que o Server Action seja chamado manipulado.
export async function updateMySponsorBannerAction(bannerUrl: string | null) {
  const parsed = z.string().url().nullable().safeParse(bannerUrl);
  if (!parsed.success) return { success: false, message: 'URL de banner inválida.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('update_my_sponsor_banner', { p_banner_url: parsed.data });
  if (error) return { success: false, message: error.message };

  revalidatePath('/minha-conta/patrocinador');
  return { success: true, message: 'Banner atualizado.' };
}
