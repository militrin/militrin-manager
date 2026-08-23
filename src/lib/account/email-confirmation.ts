/**
 * Fonte unica de "conta com e-mail confirmado" para todo o app -- nunca
 * reimplementar essa checagem em cada tela/action. `email_confirmed_at` vem
 * direto do objeto `user` do Supabase Auth (supabase.auth.getUser()), nunca
 * de uma tabela nossa.
 */
export function isEmailConfirmed(user: { email_confirmed_at?: string | null } | null | undefined): boolean {
  return Boolean(user?.email_confirmed_at);
}

/**
 * Mascara um e-mail para exibicao em telas publicas (ex.: "Verifique seu
 * e-mail"): mantem os 2 primeiros caracteres do usuario e o dominio inteiro,
 * troca o resto por asteriscos. Nunca usar o e-mail completo em telas que
 * nao exigem sessao autenticada do proprio dono.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) return trimmed;
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));
  const maskedLength = Math.max(local.length - visible.length, 3);
  return `${visible}${'*'.repeat(maskedLength)}${domain}`;
}

export const ACCOUNT_NOT_CONFIRMED_MESSAGE = 'Confirme seu e-mail para concluir esta ação. Verifique sua caixa de entrada ou reenvie o link de confirmação.';
