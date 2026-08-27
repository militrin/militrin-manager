// Contrato central de um problema de integridade operacional (ver migration
// 20260818000000_operational_integrity_module.sql). Consumido por Dashboard
// E pela Central -- nenhum dos dois recalcula a regra, so exibem o que a RPC
// get_operational_integrity_report ja devolve agrupado.
export type IntegritySeverity = 'critical' | 'attention' | 'warning';

export type IntegrityIssueSummary = {
  code: string;
  severity: IntegritySeverity;
  domain: string;
  title: string;
  description: string;
  eventId: string | null;
  affectedCount: number;
  actionLabel: string | null;
  actionHref: string | null;
  sampleEntityType: string | null;
  sampleEntityId: string | null;
  sampleMetadata: unknown;
};

export type IntegrityTotals = {
  critical: number;
  attention: number;
  warning: number;
  ok: number;
};

export const INTEGRITY_DOMAIN_LABELS: Record<string, string> = {
  titularidade: 'Titularidade',
  ingressos_pedidos: 'Ingressos / Pedidos',
  categoria_preco: 'Categoria / Lote / Preço',
  camisetas_kits: 'Camisetas e Kits',
  estoque: 'Estoque',
  checkin_retirada: 'Check-in / Retirada',
  cadastros: 'Cadastros',
  configuracao_evento: 'Configuração do evento',
};

export const INTEGRITY_SEVERITY_LABELS: Record<IntegritySeverity, string> = {
  critical: 'Bloqueio',
  attention: 'Precisa de atenção',
  warning: 'Aviso',
};

// Unica fonte de verdade do resumo "X bloqueios | Y precisam de atenção | Z
// avisos | W verificações aprovadas" -- usada pelo card do Dashboard E pela
// Central, para que os dois numeros nunca divirjam.
export function summarizeIntegrityReport(issues: IntegrityIssueSummary[], totalDetectorCount: number): IntegrityTotals {
  const critical = issues.filter((issue) => issue.severity === 'critical').length;
  const attention = issues.filter((issue) => issue.severity === 'attention').length;
  const warning = issues.filter((issue) => issue.severity === 'warning').length;
  const distinctCodesWithIssues = new Set(issues.map((issue) => issue.code)).size;
  const ok = Math.max(totalDetectorCount - distinctCodesWithIssues, 0);
  return { critical, attention, warning, ok };
}

export function mapReportRow(row: Record<string, unknown>): IntegrityIssueSummary {
  return {
    code: String(row.code),
    severity: row.severity as IntegritySeverity,
    domain: String(row.domain),
    title: String(row.title),
    description: String(row.description),
    eventId: row.event_id ? String(row.event_id) : null,
    affectedCount: Number(row.affected_count ?? 0),
    actionLabel: row.action_label ? String(row.action_label) : null,
    actionHref: row.action_href ? String(row.action_href) : null,
    sampleEntityType: row.sample_entity_type ? String(row.sample_entity_type) : null,
    sampleEntityId: row.sample_entity_id ? String(row.sample_entity_id) : null,
    sampleMetadata: row.sample_metadata ?? null,
  };
}
