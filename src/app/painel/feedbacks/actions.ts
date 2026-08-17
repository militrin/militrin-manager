'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { assertPermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const listSchema = z.object({
  status: z.enum(['new', 'reviewing', 'resolved', 'ignored']).nullable(),
  type: z.enum(['problem', 'suggestion', 'question']).nullable(),
  from: z.string().trim().min(1).nullable(),
  to: z.string().trim().min(1).nullable(),
});

export async function listFeedbackForAdminAction(filters: { status: string | null; type: string | null; from: string | null; to: string | null }) {
  await assertPermission('feedback.view');
  const parsed = listSchema.safeParse(filters);
  if (!parsed.success) return { success: false as const, message: 'Filtros inválidos.', feedback: [] };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('list_feedback_for_admin', {
    p_organization_id: null,
    p_status: parsed.data.status,
    p_type: parsed.data.type,
    p_from: parsed.data.from,
    p_to: parsed.data.to,
  });

  if (error) return { success: false as const, message: error.message, feedback: [] };
  return { success: true as const, feedback: data ?? [] };
}

export async function getFeedbackDetailAction(feedbackId: string) {
  await assertPermission('feedback.view');
  const parsed = z.string().uuid().safeParse(feedbackId);
  if (!parsed.success) return { success: false as const, message: 'Identificador inválido.', feedback: null };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_feedback_detail_for_admin', { p_feedback_id: parsed.data });
  if (error) return { success: false as const, message: error.message, feedback: null };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { success: false as const, message: 'Feedback não encontrado.', feedback: null };

  let screenshotUrl: string | null = null;
  if (row.screenshot_path) {
    const { data: signed } = await supabase.storage.from('feedback-screenshots').createSignedUrl(row.screenshot_path, 300);
    screenshotUrl = signed?.signedUrl ?? null;
  }

  return { success: true as const, feedback: { ...row, screenshot_url: screenshotUrl } };
}

export async function updateFeedbackStatusAction(input: { feedbackId: string; status: string; adminNotes: string | null }) {
  await assertPermission('feedback.manage');
  const parsed = z.object({
    feedbackId: z.string().uuid(),
    status: z.enum(['new', 'reviewing', 'resolved', 'ignored']),
    adminNotes: z.string().trim().nullable(),
  }).safeParse(input);
  if (!parsed.success) return { success: false as const, message: 'Dados inválidos.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('update_feedback_status', {
    p_feedback_id: parsed.data.feedbackId,
    p_status: parsed.data.status,
    p_admin_notes: parsed.data.adminNotes,
  });

  if (error) return { success: false as const, message: error.message };
  revalidatePath('/painel/feedbacks');
  return { success: true as const, message: 'Feedback atualizado.' };
}
