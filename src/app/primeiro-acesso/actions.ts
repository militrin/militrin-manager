'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase/server';

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

  const { data: profileData, error: profileError } = await supabase.rpc('get_customer_profile', {
    p_user_id: user.id,
  });

  if (profileError) {
    return { success: false, message: profileError.message };
  }

  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const cpf = normalizeCpf(profile?.cpf);

  const newPassword = String(formData.get('new_password') ?? '').trim();
  const confirmPassword = String(formData.get('confirm_password') ?? '').trim();

  if (newPassword.length < 8) {
    return { success: false, message: 'A nova senha precisa ter no minimo 8 caracteres.' };
  }

  if (newPassword !== confirmPassword) {
    return { success: false, message: 'A confirmacao de senha nao confere.' };
  }

  if (cpf && newPassword === cpf) {
    return { success: false, message: 'A senha nao pode ser igual ao CPF.' };
  }

  const fullName = String(formData.get('full_name') ?? '').trim();
  const birthDate = normalizeDateInput(String(formData.get('birth_date') ?? ''));
  const gender = String(formData.get('gender') ?? '').trim();
  const phone = String(formData.get('phone') ?? '').replace(/\D/g, '');
  const city = String(formData.get('city') ?? '').trim();
  const email = String(user.email ?? profile?.email ?? '').trim().toLowerCase();

  if (!fullName || !birthDate || !gender || !phone || !city || !email) {
    return { success: false, message: 'Preencha todos os dados obrigatorios para concluir o primeiro acesso.' };
  }

  const passwordUpdate = await supabase.auth.updateUser({ password: newPassword });
  if (passwordUpdate.error) {
    return { success: false, message: passwordUpdate.error.message };
  }

  const profileUpdate = await supabase.rpc('upsert_customer_profile', {
    p_user_id: user.id,
    p_full_name: fullName,
    p_cpf: cpf,
    p_birth_date: birthDate,
    p_gender: gender,
    p_phone: phone,
    p_email: email,
    p_city: city,
    p_loyalty_tier_id: profile?.loyalty_tier_id ? String(profile.loyalty_tier_id) : null,
    p_loyalty_override: Boolean(profile?.loyalty_override),
    p_loyalty_override_reason: profile?.loyalty_override_reason ? String(profile.loyalty_override_reason) : null,
    p_show_in_participant_list: profile?.show_in_participant_list === undefined ? true : Boolean(profile.show_in_participant_list),
    p_allow_friend_requests: profile?.allow_friend_requests === undefined ? true : Boolean(profile.allow_friend_requests),
    p_profile_visibility: profile?.profile_visibility ? String(profile.profile_visibility) : 'participants',
  });

  if (profileUpdate.error) {
    return { success: false, message: profileUpdate.error.message };
  }

  const accountUpdate = await supabase
    .from('customer_profiles')
    .update({
      must_change_password: false,
      must_complete_profile: false,
      account_status: 'active',
      activation_completed_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);

  if (accountUpdate.error) {
    return { success: false, message: accountUpdate.error.message };
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

  revalidatePath('/minha-conta');

  return { success: true, message: 'Primeiro acesso concluido com sucesso.' };
}
