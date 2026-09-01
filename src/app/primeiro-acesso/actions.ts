'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';
import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import { upsertCustomerProfileCompat } from '@/lib/account/upsert-customer-profile';
import { updateCustomerProfileCompat } from '@/lib/account/update-customer-profile';
import { getProfileCompletionStatus } from '@/lib/account/profile-completion';
import { getParticipantInviteContext, getParticipantInviteFailureCopy } from '@/lib/account/participant-invite';
import { REQUIRED_PARTICIPANT_FIELD_CODES } from '@/lib/account/participant-issue-policy';
import { validateFirstAccessProfile, type FirstAccessFieldErrors } from '@/lib/account/first-access-validation';

export type CompleteFirstAccessResult = {
  success: boolean;
  message: string;
  code?: string;
  field_errors?: FirstAccessFieldErrors & Partial<Record<'new_password' | 'confirm_password', string>>;
  redirect_to?: string;
};

function validationFailure(
  fieldErrors: NonNullable<CompleteFirstAccessResult['field_errors']>,
  message = 'Revise os campos destacados para concluir seu cadastro.',
): CompleteFirstAccessResult {
  return { success: false, message, field_errors: fieldErrors };
}

const missingFieldLabels: Record<string, string> = {
  full_name: 'Nome completo',
  cpf: 'CPF',
  birth_date: 'Data de nascimento',
  gender: 'Genero',
  phone: 'Telefone',
  email: 'E-mail',
  city: 'Cidade',
};

function toFriendlyMissingFields(fields: string[]) {
  return fields.map((field) => missingFieldLabels[field] ?? field);
}

function translateFirstAccessPersistError(rawMessage: string) {
  const normalized = rawMessage.toLowerCase();

  if (normalized.includes('could not find') && normalized.includes('customer_profiles')) {
    return 'Nao foi possivel concluir seu cadastro por incompatibilidade temporaria do banco. Tente novamente.';
  }

  if (normalized.includes('duplicate key') || normalized.includes('unique constraint')) {
    return 'Nao foi possivel concluir seu cadastro por conflito de dados. Tente novamente.';
  }

  return 'Nao foi possivel concluir seu cadastro. Tente novamente.';
}

export async function completeFirstAccessAction(formData: FormData): Promise<CompleteFirstAccessResult> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  console.info('[first-access:submit]', {
    userIdPresent: Boolean(user.id),
  });

  const { data: profileData, error: profileError } = await supabase.rpc('get_customer_profile', {
    p_user_id: user.id,
  });

  if (profileError) {
    return { success: false, message: profileError.message };
  }

  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  console.info('[first-access:profile-load]', {
    userIdPresent: Boolean(user.id),
    profileFound: Boolean(profile),
  });

  const authEmail = String(user.email ?? '').trim().toLowerCase();
  const validation = validateFirstAccessProfile({
    full_name: formData.get('full_name'),
    cpf: formData.get('cpf'),
    birth_date: formData.get('birth_date'),
    gender: formData.get('gender'),
    phone: formData.get('phone'),
    email: authEmail,
    city: formData.get('city'),
  });
  if (!validation.success) return validationFailure(validation.fieldErrors);
  const {
    full_name: fullName,
    cpf,
    birth_date: birthDate,
    gender,
    phone,
    city,
  } = validation.values;
  const nextPath = sanitizePostFirstAccessNextPath(String(formData.get('next_path') ?? ''), '/minha-conta');
  const inviteId = String(formData.get('invite_id') ?? '').trim();

  const inviteContext = inviteId ? await getParticipantInviteContext(inviteId, user) : null;
  if (inviteId && !inviteContext?.valid) {
    return { success: false, message: getParticipantInviteFailureCopy(inviteContext?.reason).actionMessage };
  }

  // Mesma checagem de src/app/inscricao/actions.ts (signUpPublicAccountAction):
  // se este CPF ja pertence a OUTRA conta, bloqueia aqui. p_exclude_user_id
  // exclui o proprio contato desta conta (ex.: ja vinculado por um convite/
  // importacao anterior) da checagem. Fail-closed: erro na propria checagem
  // nunca vira "segue como se nao houvesse conflito" (ver comentario
  // identico em signUpPublicAccountAction sobre o bug real que isso causou).
  const { data: conflictData, error: conflictError } = await supabase.rpc('find_conflicting_registration_contact', {
    p_cpf: cpf,
    p_exclude_user_id: user.id,
  });
  if (conflictError) {
    console.error('[first-access:cpf-conflict-check-error]', {
      userIdPresent: Boolean(user.id),
      message: conflictError.message,
      code: conflictError.code ?? null,
    });
    return { success: false, message: 'Não foi possível validar seu CPF agora. Tente novamente em instantes.' };
  }
  const conflict = Array.isArray(conflictData) ? conflictData[0] : conflictData;
  if (conflict?.has_conflict) {
    return {
      success: false,
      code: 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
      message: 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.',
    };
  }

  const mustChangePassword = inviteContext
    ? inviteContext.requiresPasswordSetup
    : Boolean(profile?.must_change_password);
  const newPassword = String(formData.get('new_password') ?? '').trim();
  const confirmPassword = String(formData.get('confirm_password') ?? '').trim();

  if (mustChangePassword) {
    const passwordErrors: NonNullable<CompleteFirstAccessResult['field_errors']> = {};
    if (newPassword.length < 8) passwordErrors.new_password = 'A nova senha precisa ter no mínimo 8 caracteres.';
    else if (newPassword === cpf) passwordErrors.new_password = 'A senha não pode ser igual ao CPF.';
    if (newPassword !== confirmPassword) passwordErrors.confirm_password = 'A confirmação de senha não confere.';
    if (Object.keys(passwordErrors).length) return validationFailure(passwordErrors);
  }

  if (inviteId) {
    // Validacao do formulario, senha, convite e CPF acontece antes da primeira
    // mutacao. O claim permanece canonico e idempotente para preservar o fluxo.
    const { error: claimError } = inviteContext?.anchorKind === 'contact'
      ? await supabase.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId })
      : await supabase.rpc('claim_participant_account_invite', { p_invite_id: inviteId });
    if (claimError) return { success: false, message: claimError.message };
  }

  if (mustChangePassword) {
    const passwordUpdate = await supabase.auth.updateUser({ password: newPassword });
    if (passwordUpdate.error) {
      return { success: false, message: 'Não foi possível atualizar a senha. Tente novamente.' };
    }

    if (inviteId) {
      const passwordInviteContext = await getParticipantInviteContext(inviteId, user);
      if (!passwordInviteContext.valid || !passwordInviteContext.requiresPasswordSetup) {
        return { success: false, message: getParticipantInviteFailureCopy(passwordInviteContext.reason).actionMessage };
      }
      const admin = createServiceRoleSupabaseClient();
      const passwordCompletion = await admin
        .from('participant_account_invites')
        .update({ password_setup_completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', inviteId)
        .eq('auth_user_id', user.id)
        .eq('requires_password_setup', true)
        .is('password_setup_completed_at', null)
        .in('status', ['pending', 'claimed'])
        .select('id')
        .maybeSingle();
      if (passwordCompletion.error || !passwordCompletion.data) {
        return { success: false, message: 'A senha foi atualizada, mas não foi possível confirmar esta etapa do convite. Tente novamente.' };
      }
    }
  }

  const profileUpdate = await upsertCustomerProfileCompat(supabase, {
    userId: user.id,
    fullName,
    cpf,
    birthDate,
    gender,
    phone,
    email: null,
    city,
    loyaltyTierId: profile?.loyalty_tier_id ? String(profile.loyalty_tier_id) : null,
    loyaltyOverride: Boolean(profile?.loyalty_override),
    loyaltyOverrideReason: profile?.loyalty_override_reason ? String(profile.loyalty_override_reason) : null,
    showInParticipantList: profile?.show_in_participant_list === undefined ? true : Boolean(profile.show_in_participant_list),
    allowFriendRequests: profile?.allow_friend_requests === undefined ? true : Boolean(profile.allow_friend_requests),
    profileVisibility: profile?.profile_visibility ? String(profile.profile_visibility) : 'participants',
  });

  if (profileUpdate.error) {
    console.error('[first-access:profile-upsert-error]', {
      userIdPresent: Boolean(user.id),
      mode: profileUpdate.mode,
      error: profileUpdate.error.message,
    });
    return { success: false, message: translateFirstAccessPersistError(profileUpdate.error.message) };
  }

  const { error: contactError } = await supabase.rpc('ensure_registration_contact_for_user', {
    p_user_id: user.id,
  });
  if (contactError) {
    console.warn('[first-access:registration-contact-error]', {
      userIdPresent: Boolean(user.id),
      message: contactError.message,
    });
  }

  if (inviteId) {
    const participantId = String(inviteContext?.participant?.id ?? '');
    const allowed = new Set(inviteContext?.userResolvableFields ?? []);
    const issueValues: Record<string, string> = {};
    if (allowed.has('cpf')) issueValues.cpf = cpf;
    if (allowed.has('birth_date')) issueValues.birth_date = birthDate;
    if (allowed.has('gender')) issueValues.gender = gender;
    if (allowed.has('phone')) issueValues.phone = phone;
    if (allowed.has('email')) issueValues.email = authEmail;
    if (allowed.has('city')) issueValues.city = city;
    if (participantId && inviteContext?.openIssueIds.length && Object.keys(issueValues).length) {
      const { data: issueContext } = await supabase.from('participant_data_issues').select('order_item_id')
        .in('id', inviteContext.openIssueIds).eq('status', 'open');
      const orderItemIds = [...new Set((issueContext ?? []).map((issue) => issue.order_item_id ? String(issue.order_item_id) : null).filter(Boolean))] as string[];
      if (orderItemIds.length !== 1) return { success: false, message: 'Abra a pendencia no ingresso correto para continuar.' };
      const resolution = await supabase.rpc('resolve_ticket_data_issues', {
        p_order_item_id: orderItemIds[0],
        p_expected_issue_ids: inviteContext.openIssueIds,
        p_values: issueValues,
      });
      const resolutionData = resolution.data as { success?: boolean; message?: string } | null;
      if (resolution.error || !resolutionData?.success) {
        return { success: false, message: resolution.error?.message ?? resolutionData?.message ?? 'Não foi possível reavaliar as pendências do cadastro.' };
      }
    }
    if (participantId && inviteContext?.openIssueIds.length) {
      const { data: issueContext } = await supabase.from('participant_data_issues').select('order_item_id')
        .in('id', inviteContext.openIssueIds);
      const orderItemIds = [...new Set((issueContext ?? []).map((issue) => issue.order_item_id ? String(issue.order_item_id) : null).filter(Boolean))] as string[];
      if (orderItemIds.length !== 1) return { success: false, message: 'Abra a pendencia no ingresso correto para continuar.' };
      const finalization = await supabase.rpc('finalize_imported_ticket_after_issue_resolution', {
        p_order_item_id: orderItemIds[0],
        p_resolved_fields: Object.keys(issueValues),
      });
      if (finalization.error) return { success: false, message: finalization.error.message };
    }
  }

  const { data: linkedParticipants } = await supabase
    .from('participants')
    .select('id')
    .eq('user_id', user.id);

  for (const participant of linkedParticipants ?? []) {
    const contactUpdate = await supabase.rpc('update_registration_contact_from_participant', {
      p_participant_id: participant.id,
      p_values: { full_name: fullName, cpf, birth_date: birthDate, gender, phone, email: authEmail, city },
    });
    if (contactUpdate.error) return { success: false, message: contactUpdate.error.message };
  }

  // Libera a conta apenas depois que perfil, pendencias do convite e contatos
  // vinculados foram persistidos. Falhas anteriores mantem o primeiro acesso
  // pendente e permitem uma nova tentativa segura.
  const completedAt = new Date().toISOString();
  const accountUpdate = await updateCustomerProfileCompat(supabase, user.id, {
    must_change_password: false,
    must_complete_profile: false,
    account_status: 'active',
    activation_completed_at: completedAt,
  });

  console.info('[first-access:account-update]', {
    userIdPresent: Boolean(user.id),
    updateExecuted: true,
    appliedColumns: accountUpdate.appliedColumns,
  });

  if (accountUpdate.error) {
    console.error('[first-access:account-update-error]', {
      userIdPresent: Boolean(user.id),
      error: accountUpdate.error.message,
    });
    return { success: false, message: translateFirstAccessPersistError(accountUpdate.error.message) };
  }

  await supabase.rpc('recalculate_customer_loyalty', {
    p_user_id: user.id,
  });

  const completionStatus = await getProfileCompletionStatus(user.id, authEmail);
  console.info('[first-access:completion-after-save]', {
    userIdPresent: Boolean(user.id),
    profileFound: completionStatus.exists,
    missingFields: completionStatus.missingFields,
    isComplete: completionStatus.isComplete,
  });

  if (completionStatus.error) {
    console.error('[first-access:completion-check-error]', {
      userIdPresent: Boolean(user.id),
      error: completionStatus.error,
    });
    return { success: false, message: 'Nao foi possivel concluir seu cadastro.' };
  }

  if (!completionStatus.isComplete) {
    const pendingFields = toFriendlyMissingFields(completionStatus.missingFields);
    const pendingText = pendingFields.length ? ` Campos pendentes: ${pendingFields.join(', ')}.` : '';
    return {
      success: false,
      message: `Nao foi possivel concluir seu cadastro.${pendingText}`,
    };
  }

  revalidatePath('/minha-conta');

  const linkedParticipantIds = (linkedParticipants ?? []).map((participant) => String(participant.id));
  const { count: requiredIssueCount } = linkedParticipantIds.length
    ? await supabase.from('participant_data_issues').select('id', { count: 'exact', head: true })
      .in('participant_id', linkedParticipantIds).eq('status', 'open')
      .eq('resolution_scope', 'user_resolvable').in('field_code', [...REQUIRED_PARTICIPANT_FIELD_CODES])
    : { count: 0 };

  return {
    success: true,
    message: 'Primeiro acesso concluído com sucesso.',
    redirect_to: (requiredIssueCount ?? 0) > 0 ? '/primeiro-acesso/pendencias' : nextPath,
  };
}
