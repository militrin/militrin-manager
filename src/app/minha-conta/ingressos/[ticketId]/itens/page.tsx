import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requestTicketItemChangeAction } from '@/app/minha-conta/actions';

function first<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function object(value: unknown) { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
// request_ticket_item_change sempre grava requested_variant como {id,name,value} -- ver auditoria do fluxo de aprovacao.
function requestedLabel(requestedVariant: unknown) {
  const v = object(requestedVariant);
  return String(v.name ?? v.value ?? 'novo valor');
}

export default async function TicketItemsPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) notFound();
  const { data: ticket } = await supabase.from('tickets').select('id,orders!inner(id,user_id,event_id,events(id,name,shirt_order_deadline,allow_participant_item_changes))').eq('id', ticketId).eq('orders.user_id', user.id).maybeSingle();
  if (!ticket) notFound();
  const order = first(ticket.orders); const event = first(order?.events);
  const [{ data: links }, { data: requests }] = await Promise.all([
    supabase.from('participant_kit_items').select('id,kit_item_id,variant_data,status,event_kit_items(id,name,item_type,requires_variant,allow_participant_change,event_kit_item_variants(id,name,value,is_active,sort_order))').eq('ticket_id', ticketId),
    supabase.from('ticket_item_change_requests').select('id,kit_item_id,status,current_variant,requested_variant,requested_at,reviewed_at,reason,review_notes').eq('ticket_id', ticketId).order('requested_at', { ascending: false }),
  ]);
  const deadline = event?.shirt_order_deadline ? new Date(String(event.shirt_order_deadline)) : null;
  // eslint-disable-next-line react-hooks/purity
  const deadlinePassed = Boolean(deadline && Date.now() > deadline.getTime());
  async function submit(formData: FormData) { 'use server'; await requestTicketItemChangeAction(formData); }
  return <section className="space-y-4">
    <nav className="text-xs text-slate-400"><Link href="/minha-conta/ingressos">Meus ingressos</Link> → <Link href={`/minha-conta/ingressos/${ticketId}`}>{String(event?.name ?? 'Evento')}</Link> → Ingresso → Itens</nav>
    <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5"><h1 className="text-xl font-semibold">Itens do ingresso</h1><div className="mt-4 grid gap-3">{(links ?? []).map((link) => {
      const item = first(link.event_kit_items); const variants = (item?.event_kit_item_variants ?? []).filter((variant) => variant.is_active).sort((a,b) => a.sort_order-b.sort_order);
      const current = object(link.variant_data);
      // requests ja vem ordenado por requested_at desc (query acima) -- o
      // primeiro match e sempre a solicitacao mais recente pra este item.
      const latest = requests?.find((request) => request.kit_item_id === link.kit_item_id);
      const pending = latest?.status === 'pending';
      // Regra do redesign do detalhe do ingresso: pro participante, a UNICA
      // parte do kit que pode ser alterada e a camiseta -- copo/tirante/
      // porta-copo/demais itens fixos nunca ganham controle de alteracao
      // aqui, mesmo que event/item já permitissem individualmente.
      const canChange = Boolean(item?.item_type === 'shirt' && event?.allow_participant_item_changes && item?.allow_participant_change && item?.requires_variant && !pending && !deadlinePassed);
      const currentLabel = String(current.variant_name ?? current.variant_value ?? current.shirt_size ?? 'Opção única');
      return <article key={link.id} className="rounded-xl border border-slate-800 p-4"><h2 className="font-medium">{item?.name ?? 'Item'}</h2><p className="mt-1 text-sm text-slate-400">{item?.requires_variant ? `Opção atual: ${currentLabel}` : 'Opção única'}</p>
        {/* Estado da ultima solicitacao pro participante, sem status tecnico
            de banco -- pendente/aprovada/rejeitada, nunca 'pending'/'approved'/
            'rejected' cru. Aprovada e rejeitada continuam visiveis (nao so
            enquanto pending) pra nunca deixar o participante sem saber o que
            aconteceu -- ver auditoria do fluxo de aprovacao (P0). */}
        {pending ? <p className="mt-2 text-sm text-amber-200">Alteração solicitada · Aguardando confirmação do organizador</p> : null}
        {latest?.status === 'approved' ? <p className="mt-2 text-sm text-emerald-300">Tamanho alterado para {requestedLabel(latest.requested_variant)}</p> : null}
        {latest?.status === 'rejected' ? <p className="mt-2 text-sm text-rose-300">Solicitação não aprovada{latest.review_notes ? ` — ${latest.review_notes}` : ''}</p> : null}
        {canChange ? <form action={submit} className="mt-3 flex flex-wrap gap-2"><input type="hidden" name="ticket_id" value={ticketId}/><input type="hidden" name="kit_item_id" value={String(link.kit_item_id)}/><select name="requested_variant_id" className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm">{variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name || variant.value}</option>)}</select><button className="rounded-lg border border-emerald-500/40 px-3 py-2 text-sm text-emerald-200">Solicitar alteração</button></form> : null}
      </article>;
    })}</div></div>
    {(requests ?? []).length ? <div className="rounded-2xl border border-slate-800 p-5"><h2 className="font-semibold">Histórico</h2>{requests?.map((request) => <p key={request.id} className="mt-2 text-sm">{String(object(request.current_variant).name ?? object(request.current_variant).value ?? 'Atual')} → {String(object(request.requested_variant).name ?? object(request.requested_variant).value)} · {request.status === 'approved' ? 'Aprovada' : request.status === 'rejected' ? 'Rejeitada' : 'Pendente'}</p>)}</div> : null}
  </section>;
}
