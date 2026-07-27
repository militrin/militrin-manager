'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { isValidCpf } from '@/lib/validation/registration';
import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import { upsertCustomerProfileCompat } from '@/lib/account/upsert-customer-profile';
import { updateCustomerProfileCompat } from '@/lib/account/update-customer-profile';
import { getProfileCompletionStatus } from '@/lib/account/profile-completion';

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

function normalizeCpf(value: unknown) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

function normalizeDateInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export async function completeFirstAccessAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const privacyAcceptedRaw = formData.get('privacyAccepted');
  const acceptedPrivacy = privacyAcceptedRaw === 'on' || privacyAcceptedRaw === 'true';

  console.info('[first-access:submit]', {
    userIdPresent: Boolean(user.id),
    privacyReceived: acceptedPrivacy,
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

  const fullName = String(formData.get('full_name') ?? '').trim();
  const cpf = normalizeCpf(formData.get('cpf'));
  const birthDate = normalizeDateInput(String(formData.get('birth_date') ?? ''));
  const gender = String(formData.get('gender') ?? '').trim();
  const phone = String(formData.get('phone') ?? '').replace(/\D/g, '');
  const city = String(formData.get('city') ?? '').trim();
  const authEmail = String(user.email ?? '').trim().toLowerCase();
  const nextPath = sanitizePostFirstAccessNextPath(String(formData.get('next_path') ?? ''), '/minha-conta');

  if (!fullName || !cpf || !birthDate || !gender || phone.length < 10 || !city || !authEmail) {
    return { success: false, message: 'Preencha todos os dados obrigatórios para concluir o primeiro acesso.' };
  }

  if (!isValidCpf(cpf)) {
    return { success: false, message: 'Informe um CPF válido.' };
  }

  const mustChangePassword = Boolean(profile?.must_change_password);
  const newPassword = String(formData.get('new_password') ?? '').trim();
  const confirmPassword = String(formData.get('confirm_password') ?? '').trim();

  if (mustChangePassword) {
    if (newPassword.length < 8) {
      return { success: false, message: 'A nova senha precisa ter no mínimo 8 caracteres.' };
    }

    if (newPassword !== confirmPassword) {
      return { success: false, message: 'A confirmação de senha não confere.' };
    }

    if (newPassword === cpf) {
      return { success: false, message: 'A senha não pode ser igual ao CPF.' };
    }

    const passwordUpdate = await supabase.auth.updateUser({ password: newPassword });
    if (passwordUpdate.error) {
      return { success: false, message: 'Não foi possível atualizar a senha. Tente novamente.' };
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

  if (cpf) {
    await supabase.rpc('link_participation_history_by_cpf', {
      p_user_id: user.id,
      p_cpf: cpf,
      p_actor: `first-access:${user.id}`,
    });
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

  return {
    success: true,
    message: 'Primeiro acesso concluído com sucesso.',
    redirect_to: nextPath,
  };
}
