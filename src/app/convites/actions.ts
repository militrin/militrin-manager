'use server';

import { revalidatePath } from 'next/cache';
import { assertPermission } from '@/lib/admin/permissions';
import { dispatchFirstAccessEmail, markInvitedAccountPending } from '@/lib/account/first-access-invite-dispatch';
import { canResendInviteCenter, classifyInviteCenterRow } from '@/lib/invites/invite-center-status';
import { getCurrentOrganizationContext } from '@/lib/organizations/current-organization';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import type { InviteCenterListPayload } from '@/lib/invites/invite-center-types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InviteCenterQuery = {
  eventId?: string | null;
  importBatchId?: string | null;
  status?: string | null;
  shared?: string | null;
  q?: string | null;
  sort?: string | null;
  page?: string | null;
  pageSize?: string | null;
};

function pageSizeFrom(value: string | null | undefined) {
  const parsed = Number(value);
  if (parsed === 50 || parsed === 100) return parsed;
  return 25;
}

export async function loadInviteCenter(query: InviteCenterQuery) {
  await assertPermission('invites.view');
  const organization = (await getCurrentOrganizationContext()).organization;
  const supabase = await createServerSupabaseClient();
  const page = Math.max(1, Number(query.page || 1) || 1);
  const pageSize = pageSizeFrom(query.pageSize);
  const { data, error } = await supabase.rpc('list_invite_center', {
    p_event_id: query.eventId && UUID_PATTERN.test(query.eventId) ? query.eventId : null,
    p_import_batch_id: query.importBatchId && UUID_PATTERN.test(query.importBatchId) ? query.importBatchId : null,
    p_status: query.status || 'all',
    p_shared: query.shared || 'all',
    p_search: query.q || null,
    p_sort: query.sort || 'attention',
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
    p_organization_id: organization?.id ?? null,
    p_row_key: null,
  });
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, data: data as InviteCenterListPayload };
}

export async function loadInviteCenterDetail(rowKey: string) {
  await assertPermission('invites.view');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_invite_center_detail', { p_row_key: rowKey });
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, data };
}

export async function previewInviteCenterBulkResendAction() {
  await assertPermission('invites.bulk_resend');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('preview_invite_center_bulk_resend');
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, preview: data, sendsNothing: true };
}

export async function startInviteCenterBulkResendAction() {
  await assertPermission('invites.bulk_resend');
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('start_invite_center_bulk_resend');
  if (error) return { success: false as const, message: error.message };
  revalidatePath('/convites');
  return { success: true as const, job: data };
}

export async function processInviteCenterBulkChunkAction(jobId: string) {
  await assertPermission('invites.bulk_resend');
  if (!UUID_PATTERN.test(jobId)) return { success: false as const, message: 'Job inválido.' };
  const supabase = await createServerSupabaseClient();
  const claimed = await supabase.rpc('claim_invite_center_bulk_items', { p_job_id: jobId, p_limit: 5 });
  if (claimed.error) return { success: false as const, message: claimed.error.message };
  const payload = claimed.data as { job?: Record<string, unknown>; items?: Array<Record<string, unknown>> };
  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of items) {
    const contactId = String(item.registration_contact_id ?? '');
    const itemId = String(item.id ?? '');
    const result = contactId
      ? await resendInviteCenterAction(contactId, 'bulk')
      : { success: false as const, message: 'Contato ausente.' };
    const sent = result.success && 'sent' in result && result.sent;
    const finished = await supabase.rpc('finish_invite_center_bulk_item', {
      p_item_id: itemId,
      p_status: sent ? 'sent' : result.success ? 'skipped' : 'failed',
      p_error_safe: result.success ? null : result.message,
    });
    if (finished.error) return { success: false as const, message: finished.error.message };
  }
  revalidatePath('/convites');
  return { success: true as const, job: payload.job, processed: items.length };
}

export async function resendInviteCenterAction(contactId: string, origin: 'individual' | 'bulk' = 'individual') {
  if (origin === 'bulk') await assertPermission('invites.bulk_resend');
  else await assertPermission('invites.resend');
  if (!UUID_PATTERN.test(contactId)) return { success: false as const, message: 'Cadastro inválido.' };

  const supabase = await createServerSupabaseClient();
  const eligibility = await supabase.rpc('check_registration_contact_account_invite_eligibility', {
    p_registration_contact_id: contactId,
  });
  const row = (Array.isArray(eligibility.data) ? eligibility.data[0] : eligibility.data) as {
    eligible?: boolean;
    reason_code?: string;
    reason_message?: string;
    email?: string;
  } | null;
  if (eligibility.error || !row?.eligible) {
    return {
      success: false as const,
      message: eligibility.error?.message ?? row?.reason_message ?? 'Cadastro não elegível para reenvio.',
    };
  }

  const { data: currentInvite } = await supabase
    .from('participant_account_invites')
    .select('id,status,expires_at,claimed_at,auth_user_id,claimed_user_id,auth_link_expires_at,auth_confirmed_at,password_setup_completed_at')
    .eq('registration_contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const classified = classifyInviteCenterRow({
    mixedIntendedOwners: String(row.reason_code ?? '') === 'mixed_intended_owner_single_login',
    inviteStatus: (currentInvite?.status as 'pending' | 'claimed' | 'revoked' | 'expired' | null) ?? null,
    authLinkExpiresAt: currentInvite?.auth_link_expires_at ?? null,
    authConfirmedAt: currentInvite?.auth_confirmed_at ?? null,
    passwordSetupCompletedAt: currentInvite?.password_setup_completed_at ?? null,
    expiresAt: currentInvite?.expires_at ?? null,
    accountStatus: null,
    mustCompleteProfile: false,
    mustChangePassword: false,
    activationCompletedAt: currentInvite?.status === 'claimed' ? currentInvite.claimed_at : null,
    cadastralIncomplete: false,
    jobStatus: null,
  });

  if (classified === 'concluido' || classified === 'admin_action') {
    return { success: false as const, message: 'Reenvio bloqueado para este estado.' };
  }
  if (!canResendInviteCenter(classified)) {
    return { success: false as const, message: 'Reenvio não disponível para este estado.' };
  }

  const prepared = await supabase.rpc('prepare_registration_contact_account_invite', {
    p_registration_contact_id: contactId,
  });
  if (prepared.error) return { success: false as const, message: prepared.error.message };
  const invite = (Array.isArray(prepared.data) ? prepared.data[0] : prepared.data) as { invite_id?: string; email?: string } | null;
  if (!invite?.invite_id || !invite.email) return { success: false as const, message: 'Não foi possível preparar o convite.' };

  const reasonCode = currentInvite?.auth_user_id || String(row.reason_code ?? '').startsWith('resend_invite_')
    ? 'resend_invite_center'
    : String(row.reason_code ?? 'eligible');
  const dispatched = await dispatchFirstAccessEmail({
    inviteId: invite.invite_id,
    email: invite.email,
    reasonCode,
  });
  if (dispatched.error) {
    await supabase.from('audit_logs').insert({
      action: origin === 'bulk' ? 'account_invite_bulk_item_failed' : 'account_invite_resend_failed',
      entity_type: 'participant_account_invites',
      entity_id: invite.invite_id,
      details: { contact_id: contactId, origin, error: dispatched.error.message },
    });
    return { success: true as const, sent: false, message: `Convite preparado, mas o envio falhou: ${dispatched.error.message}` };
  }
  if (dispatched.authUserId) {
    await supabase.from('participant_account_invites').update({
      auth_user_id: dispatched.authUserId,
      updated_at: new Date().toISOString(),
    }).eq('id', invite.invite_id);
    await markInvitedAccountPending(dispatched.authUserId);
  }

  await supabase.from('audit_logs').insert({
    action: origin === 'bulk' ? 'account_invite_bulk_item_resent' : 'account_invite_resent',
    entity_type: 'participant_account_invites',
    entity_id: invite.invite_id,
    details: { contact_id: contactId, origin },
  });

  revalidatePath('/convites');
  revalidatePath(`/cadastros/${contactId}`);
  return { success: true as const, sent: true, message: dispatched.resent ? 'Convite reenviado.' : 'Convite enviado.' };
}
