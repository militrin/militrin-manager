'use server';

import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';

export async function signOutAndGoToLoginAction() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect('/entrar');
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function isValidEmailFormat(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function translateResendError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('security purposes') || normalized.includes('rate limit')) {
    return 'Muitas solicitações em pouco tempo. Aguarde um instante e tente novamente.';
  }
  if (normalized.includes('already confirmed')) {
    return 'Este e-mail já foi confirmado. Você já pode entrar normalmente.';
  }
  return 'Não foi possível reenviar o e-mail. Tente novamente em instantes.';
}

export async function resendConfirmationEmailAction(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized || !isValidEmailFormat(normalized)) {
    return { success: false as const, message: 'E-mail inválido.' };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.resend({ type: 'signup', email: normalized });
  if (error) {
    return { success: false as const, message: translateResendError(error.message) };
  }

  return { success: true as const, message: 'E-mail enviado novamente. Verifique também sua caixa de spam.' };
}

export async function changeEmailBeforeConfirmationAction(input: {
  currentEmail: string;
  password: string;
  newEmail: string;
}) {
  const currentEmail = normalizeEmail(input.currentEmail);
  const newEmail = normalizeEmail(input.newEmail);
  const password = input.password ?? '';

  if (!currentEmail || !password) {
    return { success: false as const, message: 'Informe sua senha atual para confirmar a troca.' };
  }
  if (!newEmail || !isValidEmailFormat(newEmail)) {
    return { success: false as const, message: 'Informe um novo e-mail válido.' };
  }
  if (newEmail === currentEmail) {
    return { success: false as const, message: 'O novo e-mail precisa ser diferente do atual.' };
  }

  const supabase = await createServerSupabaseClient();

  // A conta ainda nao tem sessao (Supabase recusa login antes de confirmar
  // o e-mail) -- entao provamos posse da conta com a MESMA senha, via
  // signInWithPassword: 'email_not_confirmed' significa "senha correta,
  // so falta confirmar" (o GoTrue valida a senha ANTES de checar
  // confirmacao). Senha errada continua caindo em invalid_credentials.
  const attempt = await supabase.auth.signInWithPassword({ email: currentEmail, password });
  if (attempt.error) {
    const code = attempt.error.code ?? '';
    const message = attempt.error.message.toLowerCase();
    const passwordConfirmed = code === 'email_not_confirmed' || message.includes('email not confirmed');
    if (!passwordConfirmed) {
      return { success: false as const, message: 'Senha incorreta.' };
    }
  }

  const admin = createServiceRoleSupabaseClient();

  const { data: newEmailOwnerId, error: lookupNewError } = await admin.rpc('find_auth_user_id_by_email', { p_email: newEmail });
  if (lookupNewError) return { success: false as const, message: lookupNewError.message };
  if (newEmailOwnerId) {
    return {
      success: false as const,
      code: 'EMAIL_ALREADY_REGISTERED' as const,
      message: 'Este e-mail já possui uma conta cadastrada.',
    };
  }

  const { data: userId, error: lookupError } = await admin.rpc('find_auth_user_id_by_email', { p_email: currentEmail });
  if (lookupError) return { success: false as const, message: lookupError.message };
  if (!userId) return { success: false as const, message: 'Conta não encontrada.' };

  const updateResult = await admin.auth.admin.updateUserById(String(userId), {
    email: newEmail,
    email_confirm: false,
  });
  if (updateResult.error) {
    return { success: false as const, message: updateResult.error.message };
  }

  const resend = await supabase.auth.resend({ type: 'signup', email: newEmail });
  if (resend.error) {
    return {
      success: true as const,
      email: newEmail,
      message: 'E-mail atualizado, mas não foi possível reenviar a confirmação agora. Use "Reenviar e-mail" nesta tela.',
    };
  }

  return {
    success: true as const,
    email: newEmail,
    message: 'E-mail atualizado. Enviamos uma nova confirmação para o novo endereço.',
  };
}
