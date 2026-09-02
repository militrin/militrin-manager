// Traducao segura de erros de fluxo de e-mail (convite/magic link/
// recuperacao/confirmacao de cadastro) para o usuario final -- NUNCA expor
// texto cru do provedor (ex.: "PKCE code verifier not found in storage...").
// O detalhe tecnico completo fica so em log server-side; o usuario recebe
// sempre uma das 4 categorias abaixo, nunca a mensagem original.
//
// Supabase costuma devolver mensagens genericas de proposito por seguranca
// (ex.: "Token has expired or is invalid" cobre tanto expirado quanto ja
// usado quanto invalido, pra nao vazar qual dos tres aconteceu) -- por isso
// a categorizacao aqui e' best-effort via padroes conhecidos, com fallback
// seguro pra "link invalido" quando a causa exata nao pode ser determinada.
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
  const normalized = `${rawMessage} ${rawCode ?? ''}`.toLowerCase();
  if (normalized.includes('expired') || normalized.includes('otp_expired')) return 'expired';
  if (normalized.includes('already') && (normalized.includes('used') || normalized.includes('confirmed'))) return 'already_used';
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
  invite: 'Solicitar novo convite',
  magiclink: 'Solicitar novo link',
  recovery: 'Solicitar novo link',
  signup: 'Reenviar confirmação',
};

// Loga so a categoria + tipo (nunca token/verifier/mensagem crua com
// possivel dado sensivel) -- suficiente pra diagnostico sem expor segredo
// em log.
export function logSanitizedAuthLinkFailure(context: { kind: InviteLinkKind; category: InviteErrorCategory; rawCode: string | null }) {
  console.warn('[auth-link:failure]', { kind: context.kind, category: context.category, code: context.rawCode });
}

export function categorizeInviteError(input: { message?: string | null; code?: string | null }): InviteErrorCategory {
  return categorizeRawMessage(String(input.message ?? ''), input.code ?? null);
}

export function buildInviteErrorCopy(category: InviteErrorCategory, kind: InviteLinkKind): InviteErrorCopy {
  const ctaLabel = RESEND_LABELS[kind];
  const ctaHref = RESEND_HREFS[kind];
  const entity = kind === 'recovery' ? 'link' : kind === 'signup' ? 'link de confirmação' : 'convite';

  if (category === 'expired') {
    return { category, title: 'Link expirado', message: `Este ${entity} expirou. Solicite um novo ${kind === 'recovery' || kind === 'signup' ? 'link' : 'convite'}.`, ctaLabel, ctaHref };
  }
  if (category === 'already_used') {
    return { category, title: 'Link já utilizado', message: `Este ${entity} já foi utilizado. Entre na sua conta ou solicite um novo acesso.`, ctaLabel: kind === 'recovery' || kind === 'signup' ? ctaLabel : 'Entrar', ctaHref: kind === 'recovery' || kind === 'signup' ? ctaHref : '/entrar' };
  }
  if (category === 'internal') {
    return { category, title: 'Não foi possível concluir', message: 'Não foi possível concluir seu acesso agora. Tente novamente.', ctaLabel, ctaHref };
  }
  return { category, title: `Não foi possível validar este ${entity}`, message: `Não foi possível validar este ${entity}. Solicite um novo link.`, ctaLabel, ctaHref };
}
