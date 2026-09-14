export type FinancialDivergenceCorrelationKind = "store_order" | "orphan";

export type FinancialDivergenceView = {
  id: string;
  provider: string;
  provider_payment_id: string | null;
  event_type: string;
  received_at: string;
  last_error: string | null;
  correlation_kind: FinancialDivergenceCorrelationKind;
  store_order_id: string | null;
  store_order_number: string | null;
  store_order_status: string | null;
  store_payment_status: string | null;
  customer_name: string | null;
  amount: number | null;
  action_href: string | null;
  title: string;
};

export function mapFinancialDivergenceRow(row: Record<string, unknown>): FinancialDivergenceView {
  const storeOrderId = row.store_order_id ? String(row.store_order_id) : null;
  const correlationKind: FinancialDivergenceCorrelationKind =
    row.correlation_kind === "store_order" || storeOrderId ? "store_order" : "orphan";
  const amountRaw = row.amount;
  const amount = typeof amountRaw === "number"
    ? amountRaw
    : typeof amountRaw === "string" && amountRaw.trim() !== "" && Number.isFinite(Number(amountRaw))
      ? Number(amountRaw)
      : null;

  return {
    id: String(row.id),
    provider: String(row.provider ?? ""),
    provider_payment_id: row.provider_payment_id ? String(row.provider_payment_id) : null,
    event_type: String(row.event_type ?? ""),
    received_at: String(row.received_at ?? ""),
    last_error: row.last_error ? String(row.last_error) : null,
    correlation_kind: correlationKind,
    store_order_id: storeOrderId,
    store_order_number: row.store_order_number ? String(row.store_order_number) : null,
    store_order_status: row.store_order_status ? String(row.store_order_status) : null,
    store_payment_status: row.store_payment_status ? String(row.store_payment_status) : null,
    customer_name: row.customer_name ? String(row.customer_name) : null,
    amount,
    action_href: row.action_href ? String(row.action_href) : storeOrderId ? `/loja/pedidos/${storeOrderId}` : null,
    title: String(
      row.title
        ?? (correlationKind === "store_order"
          ? "Pagamento da Loja aguardando reconciliação"
          : "Pagamento sem vínculo local"),
    ),
  };
}

export function financialDivergencePanelCopy(openCount: number): {
  heading: string;
  openLabel: string;
  description: string;
} {
  const noun = openCount === 1 ? 'divergência financeira aberta' : 'divergências financeiras abertas';
  if (openCount <= 0) {
    return {
      heading: 'Gateway / Financeiro',
      openLabel: '0 divergências financeiras abertas',
      description: 'Nenhuma divergência financeira aberta. Eventos de refund processados e pedidos já reconciliados não aparecem aqui.',
    };
  }
  return {
    heading: 'Gateway / Financeiro',
    openLabel: `${openCount} ${noun}`,
    description: 'Pagamentos do gateway que ainda precisam de reconciliação operacional. Estes totais são independentes das verificações estruturais (bloqueios, atenção, avisos).',
  };
}
