// Rótulos derivados dos detectores de integridade operacional (ver migration
// 20260819000000_operational_integrity_entity_enrichment.sql). Consumido só
// pela Central -- o Dashboard só usa o total de detectores (get_operational_integrity_detector_codes().length),
// que continua igual.

export type IntegrityDetectorCheck = {
  code: string;
  domain: string;
  label: string;
};

export function mapDetectorCheckRow(row: Record<string, unknown>): IntegrityDetectorCheck {
  return {
    code: String(row.code),
    domain: String(row.domain),
    label: String(row.label),
  };
}

const ENTITY_TYPE_NOUNS: Record<string, [singular: string, plural: string]> = {
  ticket: ['ingresso', 'ingressos'],
  order_item: ['pedido', 'pedidos'],
  registration_contact: ['cadastro', 'cadastros'],
  shirt_inventory: ['item de estoque', 'itens de estoque'],
  event: ['evento', 'eventos'],
};

// "N ingressos afetados" em vez do genérico "N registros afetados" -- usa o
// sample_entity_type que a RPC agregadora já devolve, sem inventar uma
// contagem (ex.: "pessoas distintas") que o relatório não calcula hoje.
export function describeAffected(entityType: string | null, count: number): string {
  const [singular, plural] = ENTITY_TYPE_NOUNS[entityType ?? ''] ?? ['registro', 'registros'];
  const noun = count === 1 ? singular : plural;
  return `${count} ${noun} afetado${count === 1 ? '' : 's'}`;
}
