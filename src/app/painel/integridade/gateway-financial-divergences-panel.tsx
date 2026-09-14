'use client';

import Link from 'next/link';
import type { GatewayFinancialDivergence } from './actions';
import { financialDivergencePanelCopy } from '@/lib/integrity/financial-divergence';

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

function formatAmount(amount: number | null) {
  if (amount === null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
}

export function GatewayFinancialDivergencesPanel({ divergences }: Props) {
  const copy = financialDivergencePanelCopy(divergences.length);
  const hasOpen = divergences.length > 0;

  return (
    <div className={`rounded-lg border p-4 ${hasOpen ? 'border-rose-500/40 bg-rose-950/20' : 'border-slate-700 bg-slate-900/40'}`}>
      <div className="mb-3 flex items-center gap-2">
        {hasOpen ? <span className="inline-flex h-2 w-2 rounded-full bg-rose-500 animate-pulse" /> : null}
        <h2 className={`text-sm font-semibold ${hasOpen ? 'text-rose-300' : 'text-slate-200'}`}>
          Gateway / Financeiro
        </h2>
        {hasOpen ? (
          <p className="text-xs font-medium text-rose-200">{copy.openLabel}</p>
        ) : null}
      </div>
      <p className={`mb-4 text-xs ${hasOpen ? 'text-rose-200/70' : 'text-slate-400'}`}>
        {copy.description}
      </p>
      {!hasOpen ? (
        <p className="text-sm text-slate-300">{copy.openLabel}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="admin-table-zebra w-full text-xs text-left">
              <thead>
                <tr className="border-b border-rose-500/20 text-rose-300/70">
                  <th className="py-1 pr-4 font-medium">Situação</th>
                  <th className="py-1 pr-4 font-medium">Tipo</th>
                  <th className="py-1 pr-4 font-medium">Pedido</th>
                  <th className="py-1 pr-4 font-medium">Cliente</th>
                  <th className="py-1 pr-4 font-medium">Valor</th>
                  <th className="py-1 pr-4 font-medium">Gateway</th>
                  <th className="py-1 pr-4 font-medium">Evento</th>
                  <th className="py-1 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {divergences.map((d) => (
                  <tr key={d.id} className="border-b border-rose-500/10 hover:bg-rose-950/30">
                    <td className="py-2 pr-4 text-rose-100">
                      <p className="font-medium">{d.title}</p>
                      {d.action_href ? (
                        <Link href={d.action_href} className="mt-1 inline-flex min-h-8 items-center text-[11px] font-semibold text-emerald-300 hover:underline">
                          Abrir pedido →
                        </Link>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-rose-200/80">
                      {d.correlation_kind === 'store_order' ? 'Loja' : 'Sem vínculo local'}
                    </td>
                    <td className="py-2 pr-4 font-mono text-rose-200">
                      {d.store_order_number ?? '—'}
                    </td>
                    <td className="py-2 pr-4 text-rose-200/80">{d.customer_name ?? '—'}</td>
                    <td className="py-2 pr-4 tabular-nums text-rose-200">{formatAmount(d.amount)}</td>
                    <td className="py-2 pr-4 font-mono text-rose-200">
                      {d.provider_payment_id ?? <span className="text-rose-400/50">—</span>}
                    </td>
                    <td className="py-2 pr-4 text-rose-200/80">{d.event_type}</td>
                    <td className="py-2 text-rose-300/80">
                      {d.store_order_status && d.store_payment_status
                        ? `${d.store_order_status} / ${d.store_payment_status}`
                        : formatDate(d.received_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-rose-200/50">
            Para investigar: abra o pedido quando houver vínculo de Loja, ou consulte o gateway pelo ID da cobrança.
            Não utilize o botão de confirmar pagamento de ingresso sem correlação segura.
          </p>
        </>
      )}
    </div>
  );
}
