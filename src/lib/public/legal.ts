/**
 * Constantes das páginas públicas legais (privacidade / exclusão).
 *
 * Canal institucional temporário: oktoberfest.militrin@gmail.com
 * Preferir NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL. Sem a variável, usa o mesmo
 * endereço público — nunca credenciais da Meta nem outros segredos.
 */
export const LEGAL_LAST_UPDATED_ISO = '2026-09-07';
export const LEGAL_LAST_UPDATED_LABEL = '7 de setembro de 2026';

export const PRIVACY_POLICY_PATH = '/politica-de-privacidade';
export const DATA_DELETION_PATH = '/exclusao-de-dados';

export const MILITRIN_CONTACT_EMAIL = 'oktoberfest.militrin@gmail.com';

export function getMilitrinContactEmail(): string {
  const value = process.env.NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL?.trim() ?? '';
  if (value.includes('@') && value.length <= 254) return value;
  return MILITRIN_CONTACT_EMAIL;
}
