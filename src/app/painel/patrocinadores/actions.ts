'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const linkUrlSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().trim().url('Link inválido. Use uma URL completa, começando com http:// ou https://.').nullable(),
);

const upsertSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1, 'Nome obrigatório.'),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  linkUrl: linkUrlSchema,
});

export async function listSponsorsForAdminAction() {
  await assertPermission('sponsors.view');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('list_sponsors_for_admin');
  if (error) return { success: false as const, message: error.message, sponsors: [] };
  return { success: true as const, sponsors: data ?? [] };
}

export async function upsertSponsorAction(input: { id: string | null; name: string; isActive: boolean; sortOrder: number; linkUrl: string | null }) {
  await assertPermission('sponsors.manage');
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) return { success: false as const, message: parsed.error.issues[0]?.message ?? 'Dados inválidos para salvar o patrocinador.' };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('admin_upsert_sponsor', {
    p_id: parsed.data.id,
    p_organization_id: null,
    p_name: parsed.data.name,
    p_is_active: parsed.data.isActive,
    p_sort_order: parsed.data.sortOrder,
    p_link_url: parsed.data.linkUrl,
  });

  if (error) return { success: false as const, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true as const, message: 'Patrocinador salvo com sucesso.', sponsorId: String(data) };
}

export async function setSponsorContactAction(input: { sponsorId: string; registrationContactId: string | null }) {
  await assertPermission('sponsors.manage');
  const parsed = z.object({ sponsorId: z.string().uuid(), registrationContactId: z.string().uuid().nullable() }).safeParse(input);
  if (!parsed.success) return { success: false, message: 'Dados inválidos.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('admin_set_sponsor_contact', {
    p_sponsor_id: parsed.data.sponsorId,
    p_registration_contact_id: parsed.data.registrationContactId,
  });

  if (error) return { success: false, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true, message: parsed.data.registrationContactId ? 'Pessoa vinculada.' : 'Pessoa desvinculada.' };
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
  const { data, error } = await supabase.rpc('admin_search_sponsor_candidate_contacts', { p_term: parsed.data, p_organization_id: null });
  if (error) return { success: false as const, message: error.message, candidates: [] };
  return { success: true as const, candidates: data ?? [] };
}

export async function setSponsorCarouselOrderModeAction(orderMode: 'random' | 'manual') {
  await assertPermission('sponsors.manage');
  const parsed = z.enum(['random', 'manual']).safeParse(orderMode);
  if (!parsed.success) return { success: false, message: 'Estratégia de exibição inválida.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('admin_set_sponsor_carousel_order_mode', {
    p_organization_id: null,
    p_order_mode: parsed.data,
  });

  if (error) return { success: false, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true, message: 'Estratégia de exibição atualizada.' };
}

export async function moveSponsorAction(input: { sponsorId: string; direction: 'up' | 'down' }) {
  await assertPermission('sponsors.manage');
  const parsed = z.object({ sponsorId: z.string().uuid(), direction: z.enum(['up', 'down']) }).safeParse(input);
  if (!parsed.success) return { success: false, message: 'Dados inválidos.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('admin_move_sponsor', {
    p_sponsor_id: parsed.data.sponsorId,
    p_direction: parsed.data.direction,
  });

  if (error) return { success: false, message: error.message };
  revalidatePath('/painel/patrocinadores');
  return { success: true, message: 'Ordem atualizada.' };
}
