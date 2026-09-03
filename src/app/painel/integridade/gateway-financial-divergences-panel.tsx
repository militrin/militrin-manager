'use client';

import type { GatewayFinancialDivergence } from './actions';

interface Props {
  divergences: GatewayFinancialDivergence[];
}

function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function GatewayFinancialDivergencesPanel({ divergences }: Props) {
  if (divergences.length === 0) return null;

  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-950/20 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
        <h2 className="text-sm font-semibold text-rose-300">
          Pagamentos do gateway sem vínculo local ({divergences.length})
        </h2>
      </div>
      <p className="mb-4 text-xs text-rose-200/70">
        Pagamentos confirmados pelo gateway de pagamento que não puderam ser
        correlacionados a nenhum pedido local. Dinheiro recebido sem destino
        identificável — requer investigação manual. Nenhum ingresso foi emitido.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead>
            <tr className="border-b border-rose-500/20 text-rose-300/70">
              <th className="py-1 pr-4 font-medium">Provider</th>
              <th className="py-1 pr-4 font-medium">ID da cobrança</th>
              <th className="py-1 pr-4 font-medium">Evento</th>
              <th className="py-1 pr-4 font-medium">Recebido em</th>
              <th className="py-1 font-medium">Motivo</th>
            </tr>
          </thead>
          <tbody>
            {divergences.map((d) => (
              <tr key={d.id} className="border-b border-rose-500/10 hover:bg-rose-950/30">
                <td className="py-2 pr-4 font-mono text-rose-200">{d.provider}</td>
                <td className="py-2 pr-4 font-mono text-rose-200">
                  {d.provider_payment_id ?? <span className="text-rose-400/50">—</span>}
                </td>
                <td className="py-2 pr-4 text-rose-200/80">{d.event_type}</td>
                <td className="py-2 pr-4 tabular-nums text-rose-200/80">
                  {formatDate(d.received_at)}
                </td>
                <td className="py-2 text-rose-300/70 max-w-xs truncate" title={d.last_error ?? ''}>
                  {d.last_error ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-rose-200/50">
        Para investigar: consulte o painel do gateway usando o ID da cobrança acima.
        Não utilize o botão de confirmar pagamento sem correlação segura com um pedido local.
      </p>
    </div>
  );
}
