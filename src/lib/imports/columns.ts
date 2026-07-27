export const CANONICAL_FIELDS = [
  'full_name',
  'cpf',
  'email',
  'phone',
  'birth_date',
  'gender',
  'city',
  'event_name',
  'event_year',
  'category',
  'batch',
  'shirt_type',
  'shirt_size',
  'status',
  'amount',
  'payment_method',
] as const;

export type CanonicalField = typeof CANONICAL_FIELDS[number];

const aliases: Record<CanonicalField, string[]> = {
  full_name: ['nome', 'nome completo', 'full_name', 'participante'],
  cpf: ['cpf', 'documento'],
  email: ['email', 'e-mail', 'mail'],
  phone: ['telefone', 'celular', 'phone'],
  birth_date: ['nascimento', 'data nascimento', 'birth_date', 'data_de_nascimento'],
  gender: ['genero', 'sexo', 'gender'],
  city: ['cidade', 'city'],
  event_name: ['evento', 'evento_nome', 'legacy_event_name'],
  event_year: ['ano', 'event_year'],
  category: ['categoria', 'ticket_category', 'tipo ingresso'],
  batch: ['lote', 'batch'],
  shirt_type: ['camiseta', 'shirt_type', 'modelo camiseta'],
  shirt_size: ['tamanho', 'shirt_size', 'tam camiseta'],
  status: ['status', 'situacao', 'registration_status'],
  amount: ['valor', 'amount', 'preco'],
  payment_method: ['pagamento', 'payment', 'payment_method', 'forma_pagamento'],
};

function normalizeHeader(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function inferColumnMapping(headers: string[]) {
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }));

  const mapping: Partial<Record<CanonicalField, string>> = {};

  for (const field of CANONICAL_FIELDS) {
    const found = normalizedHeaders.find((header) => aliases[field].includes(header.normalized));
    if (found) {
      mapping[field] = found.original;
    }
  }

  return mapping;
}
