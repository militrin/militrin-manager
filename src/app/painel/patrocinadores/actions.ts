'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const upsertSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1, 'Nome obrigatório.'),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});

export async function listSponsorsForAdminAction() {
  await assertPermission('sponsors.view');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('list_sponsors_for_admin');
  if (error) return { success: false as const, message: error.message, sponsors: [] };
  return { success: true as const, sponsors: data ?? [] };
}

export async function upsertSponsorAction(input: { id: string | null; name: string; isActive: boolean; sortOrder: number }) {
  await assertPermission('sponsors.manage');
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) return { success: false as const, message: 'Dados inválidos para salvar o patrocinador.' };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('admin_upsert_sponsor', {
    p_id: parsed.data.id,
    p_organization_id: null,
    p_name: parsed.data.name,
    p_is_active: parsed.data.isActive,
    p_sort_order: parsed.data.sortOrder,
  });

  if (error) return { success: false as const, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true as const, message: 'Patrocinador salvo com sucesso.', sponsorId: String(data) };
}

export async function setSponsorUserAction(input: { sponsorId: string; userId: string | null }) {
  await assertPermission('sponsors.manage');
  const parsed = z.object({ sponsorId: z.string().uuid(), userId: z.string().uuid().nullable() }).safeParse(input);
  if (!parsed.success) return { success: false, message: 'Dados inválidos.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('admin_set_sponsor_user', {
    p_sponsor_id: parsed.data.sponsorId,
    p_user_id: parsed.data.userId,
  });

  if (error) return { success: false, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true, message: parsed.data.userId ? 'Usuário vinculado.' : 'Usuário desvinculado.' };
}

export async function setSponsorBannerAction(input: { sponsorId: string; bannerUrl: string | null }) {
  await assertPermission('sponsors.manage');
  const parsed = z.object({ sponsorId: z.string().uuid(), bannerUrl: z.string().url().nullable() }).safeParse(input);
  if (!parsed.success) return { success: false, message: 'URL de banner inválida.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('admin_set_sponsor_banner', {
    p_sponsor_id: parsed.data.sponsorId,
    p_banner_url: parsed.data.bannerUrl,
  });

  if (error) return { success: false, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true, message: 'Banner atualizado.' };
}

export async function setSponsorCarouselIntervalAction(intervalSeconds: number) {
  await assertPermission('sponsors.manage');
  const parsed = z.number().int().min(2).max(30).safeParse(intervalSeconds);
  if (!parsed.success) return { success: false, message: 'Intervalo deve estar entre 2 e 30 segundos.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('admin_set_sponsor_carousel_interval', {
    p_organization_id: null,
    p_interval_seconds: parsed.data,
  });

  if (error) return { success: false, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true, message: 'Intervalo do carrossel atualizado.' };
}

export async function searchSponsorCandidateUsersAction(term: string) {
  await assertPermission('sponsors.manage');
  const parsed = z.string().trim().min(3).safeParse(term);
  if (!parsed.success) return { success: false as const, message: 'Informe ao menos 3 caracteres.', candidates: [] };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('admin_search_sponsor_candidate_users', { p_term: parsed.data, p_organization_id: null });
  if (error) return { success: false as const, message: error.message, candidates: [] };
  return { success: true as const, candidates: data ?? [] };
}
