export function formatFirstAccessExpiry(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('pt-BR');
}

export function firstAccessInviteAdminCopy(input: {
  inviteExpiresAt?: string | null;
  authLinkExpiresAt?: string | null;
}) {
  const inviteUntil = formatFirstAccessExpiry(input.inviteExpiresAt ?? null);
  const linkUntil = formatFirstAccessExpiry(input.authLinkExpiresAt ?? null);
  const inviteLine = inviteUntil
    ? `Convite disponível até ${inviteUntil}.`
    : 'O convite interno permanece disponível por vários dias.';
  const linkLine = linkUntil
    ? `O link enviado por e-mail vale cerca de 24 horas após o envio (até ${linkUntil}).`
    : 'O link enviado por e-mail vale cerca de 24 horas após o envio.';
  return `${inviteLine} ${linkLine} Se o link expirar, reenvie a confirmação ou o acesso. O convite interno pode continuar válido.`;
}

export const PENDING_CONFIRMATION_ADMIN_COPY =
  'Conta aguardando confirmação. Não criamos outra Auth. O convite interno pode continuar válido mesmo depois que o link do e-mail expirar. Use Reenviar confirmação para gerar um novo link.';
