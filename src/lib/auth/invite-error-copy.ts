// Traducao segura de erros de fluxo de e-mail (convite/magic link/
// recuperacao/confirmacao de cadastro) para o usuario final -- NUNCA expor
// texto cru do provedor (ex.: "PKCE code verifier not found in storage...").
// O detalhe tecnico completo fica so em log server-side; o usuario recebe
// sempre uma das 4 categorias abaixo, nunca a mensagem original.
//
// GoTrue frequentemente devolve a mensagem ambigua
// "Token has expired or is invalid" para expirado, ja usado e invalido.
// Nesse caso NAO afirmamos "expirou": usamos copy generica.
export type InviteErrorCategory = 'expired' | 'already_used' | 'invalid' | 'internal';

export type InviteLinkKind = 'invite' | 'magiclink' | 'recovery' | 'signup';

export type InviteErrorCopy = {
  category: InviteErrorCategory;
  title: string;
  message: string;
  ctaLabel: string;
  ctaHref: string;
};

function categorizeRawMessage(rawMessage: string, rawCode: string | null): InviteErrorCategory {
  const code = String(rawCode ?? '').trim().toLowerCase();
  const normalized = `${rawMessage} ${code}`.toLowerCase();

  if (code === 'otp_expired') return 'expired';
  if (normalized.includes('already') && (normalized.includes('used') || normalized.includes('confirmed'))) return 'already_used';

  const ambiguousExpiredOrInvalid = normalized.includes('expired') && normalized.includes('invalid');
  if (ambiguousExpiredOrInvalid) return 'invalid';

  if (normalized.includes('otp_expired') || /\bexpired\b/.test(normalized)) return 'expired';
  if (normalized.includes('pkce') || normalized.includes('verifier') || normalized.includes('invalid') || normalized.includes('not found')) return 'invalid';
  return 'internal';
}

const RESEND_HREFS: Record<InviteLinkKind, string> = {
  invite: '/primeiro-acesso/reenviar',
  magiclink: '/primeiro-acesso/reenviar',
  recovery: '/esqueci-minha-senha',
  signup: '/verifique-seu-email',
};

const RESEND_LABELS: Record<InviteLinkKind, string> = {
  invite: 'Receber novo link',
  magiclink: 'Receber novo link',
  recovery: 'Solicitar novo link',
  signup: 'Reenviar confirmação',
};

export function logSanitizedAuthLinkFailure(context: { kind: InviteLinkKind; category: InviteErrorCategory; rawCode: string | null }) {
  console.warn('[auth-link:failure]', { kind: context.kind, category: context.category, code: context.rawCode });
}

export function categorizeInviteError(input: { message?: string | null; code?: string | null }): InviteErrorCategory {
  return categorizeRawMessage(String(input.message ?? ''), input.code ?? null);
}

export function buildInviteErrorCopy(category: InviteErrorCategory, kind: InviteLinkKind): InviteErrorCopy {
  const ctaLabel = RESEND_LABELS[kind];
  const ctaHref = RESEND_HREFS[kind];
  const entity = kind === 'recovery' ? 'link' : kind === 'signup' ? 'link de confirmação' : 'link';

  if (category === 'expired') {
    return {
      category,
      title: 'Este link expirou.',
      message: `Este ${entity} expirou. Solicite um novo acesso.`,
      ctaLabel,
      ctaHref,
    };
  }
  if (category === 'already_used') {
    return {
      category,
      title: 'Este link já foi utilizado.',
      message: `Este ${entity} já foi utilizado. Entre na sua conta ou solicite um novo acesso.`,
      ctaLabel: kind === 'recovery' || kind === 'signup' ? ctaLabel : 'Entrar',
      ctaHref: kind === 'recovery' || kind === 'signup' ? ctaHref : '/entrar',
    };
  }
  if (category === 'internal') {
    return {
      category,
      title: 'Não foi possível concluir',
      message: 'Não foi possível concluir seu acesso agora. Tente novamente.',
      ctaLabel,
      ctaHref,
    };
  }
  return {
    category,
    title: 'Este link não é mais válido.',
    message: 'Ele pode ter expirado, já ter sido utilizado ou ter sido substituído por um novo link.',
    ctaLabel,
    ctaHref,
  };
}
