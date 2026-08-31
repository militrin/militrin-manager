import Link from "next/link";
import { AdminStatusBadge } from "@/components/admin";
import type { OperationalProductItem } from "@/lib/operations/operational-product-item";
import { SOURCE_LABEL, deliveryStatusLabel } from "@/lib/operations/operational-product-item";

// Card por ITEM (nunca por pedido inteiro) -- visao consolidada dos dois
// canais de venda de produto (loja standalone e "compre junto" no checkout
// de ingresso). O operador ve so "Produto/Pedido/Comprador/Evento/Status" --
// a badge de origem e a UNICA pista de qual canal vendeu, nunca muda o
// fluxo. Origem "store" continua linkando pra ficha de pedido da loja
// (/loja/pedidos/[orderId], ja existente); "checkout" linka pro detalhe do
// pedido de inscricao (/inscricoes/pedido/[orderId], ja existente) -- nenhum
// dos dois dominios ganhou uma tela nova so por causa desta consolidacao.
export function OperationalProductItemCard({ item }: { item: OperationalProductItem }) {
  const delivery = deliveryStatusLabel(item.delivery_status);
  const href = item.source === "store" ? `/loja/pedidos/${item.order_id}` : `/inscricoes/pedido/${item.order_id}`;

  return (
    <Link
      href={href}
      className="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 transition hover:border-emerald-500/40"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-300">Pedido {item.order_reference}</p>
        <span className="rounded-full border border-slate-700 px-2.5 py-0.5 text-[11px] font-medium text-slate-400">{SOURCE_LABEL[item.source]}</span>
      </div>

      <div>
        <p className="font-medium text-slate-100">{item.quantity}x {item.product_name}</p>
        {item.variant ? <p className="text-xs text-slate-400">{item.variant}</p> : null}
      </div>

      <p className="text-xs text-slate-400">
        {item.event_id ? item.event_name : <span className="text-amber-300">Produto global / Sem evento</span>}
      </p>
      <p className="text-xs text-slate-400">{item.buyer}</p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <AdminStatusBadge status={item.payment_status} />
        <span className={`inline-flex rounded-full border px-2.5 py-1 font-medium ${delivery.className}`}>{delivery.label}</span>
      </div>

      {item.delivery_status === "delivered" ? (
        <p className="text-xs text-slate-500">
          Entregue em {item.delivered_at ? new Date(item.delivered_at).toLocaleString("pt-BR") : "-"}
          {item.delivered_by ? ` · Operador: ${item.delivered_by}` : ""}
        </p>
      ) : null}
    </Link>
  );
}
