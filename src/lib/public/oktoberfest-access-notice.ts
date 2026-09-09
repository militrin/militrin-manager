/**
 * Copy canônica da regra de comunicação Militrin × Oktoberfest.
 * Usada no Event Pass (tela/PDF/PNG), checkout e confirmações do participante.
 * Não altera regras operacionais nem o significado técnico de `tickets`.
 */
export const OKTOBERFEST_ACCESS_NOTICE = {
  title: 'Ingresso da Oktoberfest não incluso',
  short: 'Para acessar a Ala Jovem, adquira separadamente o ingresso oficial da Oktoberfest.',
  full: 'Este pacote Militrin não inclui o ingresso de acesso à Ala Jovem da Oktoberfest. O ingresso oficial deve ser adquirido separadamente.',
  reminder: 'Não se esqueça: o ingresso para acessar a Ala Jovem da Oktoberfest é adquirido separadamente.',
} as const;

export const MILITRIN_PARTICIPANT_COPY = {
  accessSingular: 'Acesso Militrin',
  accessPlural: 'Meus acessos',
  packageSingular: 'Pacote Militrin',
  viewAccess: 'Ver acesso',
  viewEventPass: 'Ver Event Pass',
  accessConfirmed: 'Seu pacote Militrin está confirmado.',
  qrForKitPickup: 'QR para retirada do kit',
} as const;
