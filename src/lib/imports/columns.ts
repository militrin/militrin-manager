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
  'external_purchase_key',
] as const;

export type CanonicalField = typeof CANONICAL_FIELDS[number];

export const CANONICAL_FIELD_LABELS: Record<CanonicalField, string> = {
  full_name: 'Nome completo',
  cpf: 'CPF',
  email: 'E-mail',
  phone: 'Telefone',
  birth_date: 'Data de nascimento',
  gender: 'Gênero',
  city: 'Cidade',
  event_name: 'Evento',
  event_year: 'Ano do evento',
  category: 'Categoria do ingresso',
  batch: 'Lote',
  shirt_type: 'Tipo de camiseta',
  shirt_size: 'Tamanho',
  status: 'Status',
  amount: 'Valor',
  payment_method: 'Forma de pagamento',
  external_purchase_key: 'Identificador original da compra',
};

const aliases: Record<CanonicalField, string[]> = {
  full_name: ['nome', 'nome completo', 'full_name'],
  cpf: ['cpf', 'documento'],
  email: ['email', 'e-mail', 'mail'],
  phone: ['telefone', 'celular', 'whatsapp', 'phone'],
  birth_date: ['nascimento', 'data de nascimento', 'data nascimento', 'birth_date', 'data_de_nascimento'],
  gender: ['genero', 'sexo', 'gender'],
  city: ['cidade', 'city'],
  event_name: ['evento', 'evento_nome', 'legacy_event_name'],
  event_year: ['ano', 'ano do evento', 'event_year'],
  category: ['categoria', 'categoria do ingresso', 'ticket_category', 'tipo ingresso'],
  batch: ['lote', 'batch'],
  shirt_type: ['camiseta', 'tipo de camiseta', 'shirt_type', 'modelo camiseta'],
  shirt_size: ['tamanho', 'shirt_size', 'tam camiseta'],
  status: ['status', 'situacao', 'registration_status'],
  amount: ['valor', 'amount', 'preco'],
  payment_method: ['pagamento', 'payment', 'payment_method', 'forma de pagamento', 'forma_pagamento'],
  external_purchase_key: [
    'pedido',
    'pedido original',
    'numero do pedido',
    'n pedido',
    'inscricao',
    'inscrição',
    'transaction',
    'transaction id',
    'transaction_id',
    'response id',
    'response_id',
    'google forms',
    'google forms id',
  ],
};

function normalizeHeader(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function inferColumnMapping(headers: string[]) {
  const normalizedAliases = Object.fromEntries(
    CANONICAL_FIELDS.map((field) => [field, new Set(aliases[field].map(normalizeHeader))]),
  ) as Record<CanonicalField, Set<string>>;
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }));
  const mapping: Partial<Record<CanonicalField, string>> = {};

  for (const field of CANONICAL_FIELDS) {
    const matches = normalizedHeaders.filter((header) => {
      if (!normalizedAliases[field].has(header.normalized)) return false;

      const candidateFields = CANONICAL_FIELDS.filter((candidate) =>
        normalizedAliases[candidate].has(header.normalized),
      );
      return candidateFields.length === 1;
    });

    if (matches.length === 1) {
      mapping[field] = matches[0].original;
    }
  }

  return mapping;
}
