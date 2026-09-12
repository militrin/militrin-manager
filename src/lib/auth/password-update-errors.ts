export const FIRST_ACCESS_SESSION_EXPIRED_MESSAGE =
  'Sua sessão de primeiro acesso expirou. Solicite um novo acesso.';

export type PasswordUpdateCategory =
  | 'already_set'
  | 'session_expired'
  | 'weak_password'
  | 'rate_limit'
  | 'temporary';

export type ClassifiedPasswordUpdateError = {
  category: PasswordUpdateCategory;
  alreadySet: boolean;
  code: string;
  status: number | null;
  userMessage: string;
};

type AuthLikeError = {
  message?: string | null;
  code?: string | null;
  status?: number | null;
  name?: string | null;
} | null | undefined;

function readStatus(error: AuthLikeError): number | null {
  return typeof error?.status === 'number' ? error.status : null;
}

function combinedText(error: AuthLikeError): string {
  return `${error?.message ?? ''} ${error?.code ?? ''} ${error?.name ?? ''}`.toLowerCase();
}

/**
 * Classifica falhas de supabase.auth.updateUser({ password }) sem expor
 * token/senha. `already_set` (same_password) significa: o Auth ja tem essa
 * senha -- o retry deve seguir o restante do onboarding, nao abortar.
 */
export function classifyPasswordUpdateError(error: AuthLikeError): ClassifiedPasswordUpdateError {
  const code = String(error?.code ?? '').trim().toLowerCase();
  const normalized = combinedText(error);
  const status = readStatus(error);

  if (code === 'same_password' || normalized.includes('different from the old password')) {
    return {
      category: 'already_set',
      alreadySet: true,
      code: code || 'same_password',
      status,
      userMessage: '',
    };
  }

  if (
    code === 'session_not_found'
    || code === 'session_expired'
    || error?.name === 'AuthSessionMissingError'
    || normalized.includes('auth session missing')
    || normalized.includes('session expired')
    || normalized.includes('not authenticated')
    || code === 'reauthentication_needed'
    || normalized.includes('reauthentication')
    || normalized.includes('reauthenticate')
  ) {
    return {
      category: 'session_expired',
      alreadySet: false,
      code: code || 'session_expired',
      status,
      userMessage: FIRST_ACCESS_SESSION_EXPIRED_MESSAGE,
    };
  }

  if (code === 'weak_password' || normalized.includes('weak password') || normalized.includes('pwned')) {
    return {
      category: 'weak_password',
      alreadySet: false,
      code: 'weak_password',
      status,
      userMessage: 'Escolha uma senha mais forte, com pelo menos 8 caracteres e que não seja fácil de adivinhar.',
    };
  }

  if (
    code === 'over_request_rate_limit'
    || normalized.includes('rate limit')
    || (normalized.includes('too many') && normalized.includes('request'))
  ) {
    return {
      category: 'rate_limit',
      alreadySet: false,
      code: code || 'rate_limit',
      status,
      userMessage: 'Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.',
    };
  }

  return {
    category: 'temporary',
    alreadySet: false,
    code: code || 'unknown',
    status,
    userMessage: 'Não foi possível concluir agora. Tente novamente.',
  };
}

export function sanitizedPasswordUpdateLog(error: AuthLikeError, classified: ClassifiedPasswordUpdateError) {
  return {
    category: classified.category,
    code: classified.code,
    status: classified.status,
    name: error?.name ?? null,
  };
}
