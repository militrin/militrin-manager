import 'server-only';

import { signupConfirmationRedirect } from '@/lib/account/auth-redirects';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export const PUBLIC_PENDING_RESEND_MESSAGE =
  'Se houver uma conta pendente para este e-mail, enviaremos uma nova confirmação.';

export const ADMIN_PENDING_RESEND_REQUESTED =
  'Envio de confirmação solicitado. A conta continua aguardando confirmação até o e-mail ser confirmado.';

export const RESEND_RATE_LIMIT_MESSAGE =
  'Muitas solicitações em pouco tempo. Aguarde um instante e tente novamente.';

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function isValidEmailFormat(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function classifyGoTrueResendError(message: string | null | undefined) {
  const normalized = (message ?? '').toLowerCase();
  if (normalized.includes('security purposes') || normalized.includes('rate limit') || normalized.includes('too many requests')) {
    return 'rate_limit' as const;
  }
  if (normalized.includes('already confirmed')) {
    return 'already_confirmed' as const;
  }
  if (normalized.includes('user not found') || normalized.includes('unable to process request')) {
    return 'not_found' as const;
  }
  return 'other' as const;
}

export type ResendSignupConfirmationResult = {
  ok: boolean;
  requested: boolean;
  rateLimited: boolean;
  message: string;
  code?: 'rate_limit' | 'already_confirmed' | 'invalid_email' | 'provider_error';
};

export async function resendSignupConfirmation(input: {
  email: string;
  nextPath?: string;
  audience: 'public' | 'admin';
}): Promise<ResendSignupConfirmationResult> {
  const email = normalizeEmail(input.email);
  if (!email || !isValidEmailFormat(email)) {
    if (input.audience === 'public') {
      return {
        ok: true,
        requested: false,
        rateLimited: false,
        message: PUBLIC_PENDING_RESEND_MESSAGE,
      };
    }
    return {
      ok: false,
      requested: false,
      rateLimited: false,
      code: 'invalid_email',
      message: 'E-mail inválido.',
    };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: signupConfirmationRedirect(input.nextPath) },
  });

  const kind = classifyGoTrueResendError(error?.message);

  if (input.audience === 'public') {
    if (kind === 'rate_limit') {
      return {
        ok: false,
        requested: false,
        rateLimited: true,
        code: 'rate_limit',
        message: RESEND_RATE_LIMIT_MESSAGE,
      };
    }
    return {
      ok: true,
      requested: !error || kind === 'not_found' || kind === 'already_confirmed',
      rateLimited: false,
      message: PUBLIC_PENDING_RESEND_MESSAGE,
    };
  }

  if (kind === 'rate_limit') {
    return {
      ok: false,
      requested: false,
      rateLimited: true,
      code: 'rate_limit',
      message: RESEND_RATE_LIMIT_MESSAGE,
    };
  }
  if (kind === 'already_confirmed') {
    return {
      ok: false,
      requested: false,
      rateLimited: false,
      code: 'already_confirmed',
      message: 'Este e-mail já foi confirmado. A pessoa já pode entrar normalmente.',
    };
  }
  if (error) {
    return {
      ok: false,
      requested: false,
      rateLimited: false,
      code: 'provider_error',
      message: 'Não foi possível reenviar a confirmação agora. Tente novamente em instantes.',
    };
  }
  return {
    ok: true,
    requested: true,
    rateLimited: false,
    message: ADMIN_PENDING_RESEND_REQUESTED,
  };
}
