import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/Sidebar';
import {
  AdminActivityTimeline,
  AdminEmptyState,
  AdminPageHeader,
  AdminSection,
  AdminStatCard,
  AdminStatusBadge,
} from '@/components/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';
import { changeParticipantShirtAction, confirmParticipantPaymentAction, resendParticipantTicketAction } from '../actions';
import { getAdminAccessContext } from '@/lib/admin/access';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function mapStatus(value: string | null | undefined) {
  const status = String(value ?? 'pending').toLowerCase();
  if (status === 'paid') return 'confirmed';
  return status;
}

export default async function ParticipantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const { canViewFinancial } = await getAdminAccessContext();

  const { data: participant, error } = await supabase
    .from('participants')
    .select('id, event_id, user_id, full_name, cpf, birth_date, gender, phone, email, city, shirt_type, shirt_size, registration_status, created_at, notes, base_amount, discount_amount, final_amount, ticket_categories(name), registration_batches(name), events(name, year)')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (!participant?.id) notFound();

  const [{ data: profileData }, { data: paymentData }, { data: orderData }, { data: ticketData }, { data: historyData }, { data: auditData }, { data: inventoryData }, { data: kitData }] = await Promise.all([
    participant.user_id ? supabase.rpc('get_customer_profile', { p_user_id: participant.user_id }) : Promise.resolve({ data: null }),
    supabase
      .from('payments')
      .select('id, amount, discount_amount, final_amount, payment_method, payment_status, created_at, paid_at, expires_at')
      .eq('participant_id', participant.id)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('orders')
      .select('id, order_number, status, base_amount, discount_amount, final_amount, created_at, confirmed_at, cancelled_at')
      .eq('participant_id', participant.id)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('tickets')
      .select('id, token, status, issued_at, used_at')
      .eq('participant_id', participant.id)
      .order('issued_at', { ascending: false })
      .limit(1),
    supabase
      .from('participation_history')
      .select('id, status')
      .or(`participant_id.eq.${participant.id},cpf.eq.${participant.cpf}`),
    supabase
      .from('audit_logs')
      .select('id, action, created_at, details')
      .eq('entity_id', participant.id)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('shirt_inventory')
      .select('shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity')
      .eq('event_id', participant.event_id)
      .order('shirt_type', { ascending: true })
      .order('shirt_size', { ascending: true }),
    supabase.rpc('get_participant_kit_items', { p_participant_id: participant.id }),
  ]);

  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const payment = Array.isArray(paymentData) ? paymentData[0] : paymentData;
  const order = Array.isArray(orderData) ? orderData[0] : orderData;
  const ticket = Array.isArray(ticketData) ? ticketData[0] : ticketData;
  const category = Array.isArray(participant.ticket_categories) ? participant.ticket_categories[0] : participant.ticket_categories;
  const batch = Array.isArray(participant.registration_batches) ? participant.registration_batches[0] : participant.registration_batches;
  const eventObj = Array.isArray(participant.events) ? participant.events[0] : participant.events;

  const historyRows = historyData ?? [];
  const confirmedHistoryCount = historyRows.filter((item) => String(item.status ?? '') === 'confirmed').length;
  const levelName = profile?.loyalty_tier_name ? String(profile.loyalty_tier_name) : 'Novato';

  const kitItems = (kitData ?? []) as Array<Record<string, unknown>>;
  const kitDelivered = kitItems.filter((item) => String(item.status ?? '') === 'delivered').length;

  const timelineItems = [
    {
      id: `participant-created-${participant.id}`,
      title: 'Inscrição criada',
      description: `Participante ${participant.full_name}`,
      date: participant.created_at ? formatDateTimeBR(String(participant.created_at), ' às ') : undefined,
      status: mapStatus(String(participant.registration_status ?? 'pending')),
    },
    ...(payment
      ? [
          {
            id: `payment-created-${String(payment.id)}`,
            title: 'Pagamento criado',
            description: `Método: ${String(payment.payment_method ?? '-')}`,
            date: payment.created_at ? formatDateTimeBR(String(payment.created_at), ' às ') : undefined,
            status: mapStatus(String(payment.payment_status ?? 'pending')),
          },
        ]
      : []),
    ...(payment?.paid_at
      ? [
          {
            id: `payment-paid-${String(payment.id)}`,
            title: 'Pagamento confirmado',
            description: 'Pagamento marcado como pago.',
            date: formatDateTimeBR(String(payment.paid_at), ' às '),
            status: 'confirmed',
          },
        ]
      : []),
    ...(ticket
      ? [
          {
            id: `ticket-issued-${String(ticket.id)}`,
            title: 'Ticket emitido',
            description: `Token: ${String(ticket.token ?? '').slice(0, 8)}...`,
            date: ticket.issued_at ? formatDateTimeBR(String(ticket.issued_at), ' às ') : undefined,
            status: mapStatus(String(ticket.status ?? 'active')),
          },
        ]
      : []),
    ...(ticket?.used_at
      ? [
          {
            id: `checkin-${String(ticket.id)}`,
            title: 'Check-in realizado',
            description: 'Ingresso utilizado na entrada do evento.',
            date: formatDateTimeBR(String(ticket.used_at), ' às '),
            status: 'used',
          },
        ]
      : []),
    ...(auditData ?? []).map((log) => ({
      id: `audit-${String(log.id)}`,
      title: String(log.action ?? 'Atualização de dados'),
      description: log.details ? JSON.stringify(log.details) : undefined,
      date: log.created_at ? formatDateTimeBR(String(log.created_at), ' às ') : undefined,
      status: 'active',
    })),
  ]
    .sort((a, b) => new Date(String(b.date ?? 0)).getTime() - new Date(String(a.date ?? 0)).getTime())
    .slice(0, 20);

  const shirtOptions = (inventoryData ?? []).map((item) => {
    const available = Math.max(0, Number(item.total_quantity ?? 0) - Number(item.reserved_quantity ?? 0) - Number(item.delivered_quantity ?? 0));
    return {
      key: `${String(item.shirt_type)}|${String(item.shirt_size)}`,
      label: `${String(item.shirt_type)} ${String(item.shirt_size)} (${available} disponível)` ,
      shirtType: String(item.shirt_type),
      shirtSize: String(item.shirt_size),
      available,
    };
  });

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader
            title="Ficha completa do participante"
            subtitle={participant.full_name}
            actions={
              <div className="flex flex-wrap gap-2">
                <Link href="/inscricoes" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Voltar</Link>
                <Link href={`/inscricoes/${participant.id}/editar`} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Editar</Link>
              </div>
            }
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <AdminStatCard label="Participações" value={confirmedHistoryCount} />
            <AdminStatCard label="Nível atual" value={levelName} />
            <AdminStatCard label="Kits entregues" value={`${kitDelivered}/${kitItems.length}`} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <AdminSection title="A. Dados pessoais" description="Informações cadastrais e vínculo de conta">
              <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
                <p><span className="text-slate-400">Nome:</span> {participant.full_name}</p>
                <p><span className="text-slate-400">CPF:</span> {participant.cpf}</p>
                <p><span className="text-slate-400">Nascimento:</span> {participant.birth_date ? formatDateBR(String(participant.birth_date)) : '-'}</p>
                <p><span className="text-slate-400">Gênero:</span> {participant.gender ?? '-'}</p>
                <p><span className="text-slate-400">Telefone:</span> {participant.phone}</p>
                <p><span className="text-slate-400">E-mail:</span> {participant.email}</p>
                <p><span className="text-slate-400">Cidade:</span> {participant.city ?? '-'}</p>
                <p><span className="text-slate-400">Conta vinculada:</span> {participant.user_id ? 'Sim' : 'Não'}</p>
              </div>
            </AdminSection>

            <AdminSection title="B. Inscrição atual" description="Contexto de evento e categoria">
              <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
                <p><span className="text-slate-400">Evento:</span> {eventObj?.name ? String(eventObj.name) : '-'}</p>
                <p><span className="text-slate-400">Categoria:</span> {category?.name ? String(category.name) : '-'}</p>
                <p><span className="text-slate-400">Lote:</span> {batch?.name ? String(batch.name) : '-'}</p>
                <p><span className="text-slate-400">Status:</span> <AdminStatusBadge status={mapStatus(String(participant.registration_status ?? 'pending'))} /></p>
                <p><span className="text-slate-400">Camiseta:</span> {participant.shirt_type} {participant.shirt_size}</p>
                <p><span className="text-slate-400">Origem:</span> Portal público</p>
              </div>

              <form
                className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]"
                action={async (formData) => {
                  'use server';
                  const value = String(formData.get('shirt') ?? '');
                  const [shirtType, shirtSize] = value.split('|');
                  if (shirtType && shirtSize) {
                    await changeParticipantShirtAction({ participantId: participant.id, shirtType, shirtSize });
                  }
                }}
              >
                <select name="shirt" defaultValue={`${participant.shirt_type}|${participant.shirt_size}`} className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm">
                  {shirtOptions.map((option) => (
                    <option key={option.key} value={`${option.shirtType}|${option.shirtSize}`} disabled={option.available <= 0 && option.key !== `${participant.shirt_type}|${participant.shirt_size}`}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button type="submit" className="h-10 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200">Alterar camiseta</button>
              </form>
            </AdminSection>

            <AdminSection title="C. Pedido e pagamento" description="Resumo financeiro e status atual">
              {canViewFinancial ? (
                <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
                  <p><span className="text-slate-400">Pedido:</span> {order?.order_number ? String(order.order_number) : '-'}</p>
                  <p><span className="text-slate-400">Status pedido:</span> <AdminStatusBadge status={mapStatus(String(order?.status ?? participant.registration_status ?? 'pending'))} /></p>
                  <p><span className="text-slate-400">Valor original:</span> {money(Number(order?.base_amount ?? participant.base_amount ?? 0))}</p>
                  <p><span className="text-slate-400">Desconto:</span> {money(Number(order?.discount_amount ?? participant.discount_amount ?? 0))}</p>
                  <p><span className="text-slate-400">Valor final:</span> {money(Number(order?.final_amount ?? payment?.final_amount ?? participant.final_amount ?? 0))}</p>
                  <p><span className="text-slate-400">Método:</span> {payment?.payment_method ? String(payment.payment_method) : '-'}</p>
                  <p><span className="text-slate-400">Status pagamento:</span> <AdminStatusBadge status={mapStatus(String(payment?.payment_status ?? 'pending'))} /></p>
                  <p><span className="text-slate-400">Pagamento em:</span> {payment?.paid_at ? formatDateTimeBR(String(payment.paid_at), ' às ') : '-'}</p>
                </div>
              ) : (
                <AdminEmptyState title="Valores ocultos" description="Acesso financeiro não habilitado para este usuário administrativo." />
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <form action={async () => { 'use server'; await confirmParticipantPaymentAction(participant.id); }}>
                  <button type="submit" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">Confirmar pagamento</button>
                </form>
                <form action={async () => { 'use server'; await resendParticipantTicketAction(participant.id); }}>
                  <button type="submit" className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">Reenviar ingresso</button>
                </form>
              </div>
            </AdminSection>

            <AdminSection title="D. Ingresso" description="Ticket, QR e check-in">
              {ticket ? (
                <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
                  <p><span className="text-slate-400">Ticket:</span> {String(ticket.id)}</p>
                  <p><span className="text-slate-400">Token:</span> {String(ticket.token ?? '-')}</p>
                  <p><span className="text-slate-400">Status:</span> <AdminStatusBadge status={mapStatus(String(ticket.status ?? 'pending'))} /></p>
                  <p><span className="text-slate-400">Check-in:</span> {ticket.used_at ? formatDateTimeBR(String(ticket.used_at), ' às ') : 'Não realizado'}</p>
                  <p className="sm:col-span-2">
                    <Link href={`/minha-conta/ingressos/${ticket.id}`} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 inline-flex">
                      Visualizar QR
                    </Link>
                  </p>
                </div>
              ) : (
                <AdminEmptyState title="Ingresso não emitido" description="O ticket aparece automaticamente após confirmação de pagamento." />
              )}
            </AdminSection>

            <AdminSection title="E. Kit" description="Itens previstos e entregues">
              {kitItems.length === 0 ? (
                <AdminEmptyState title="Sem itens de kit" description="Não há itens de kit vinculados a este participante." />
              ) : (
                <div className="space-y-2">
                  {kitItems.map((item) => (
                    <div key={String(item.kit_item_id)} className="flex flex-wrap items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200">
                      <p>{String(item.item_name)} x{Number(item.quantity ?? 1)}</p>
                      <div className="flex items-center gap-2">
                        <AdminStatusBadge status={String(item.status ?? 'reserved')} />
                        <span className="text-xs text-slate-400">{item.delivered_at ? formatDateTimeBR(String(item.delivered_at), ' às ') : '-'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </AdminSection>

            <AdminSection title="F. Histórico Militrin" description="Participações e nível atual">
              <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
                <p><span className="text-slate-400">Participações confirmadas:</span> {confirmedHistoryCount}</p>
                <p><span className="text-slate-400">Nível atual:</span> {levelName}</p>
                <p><span className="text-slate-400">Conta vinculada:</span> {participant.user_id ? 'Sim' : 'Não'}</p>
                <p><span className="text-slate-400">Perfil completo:</span> {profile?.must_complete_profile ? 'Não' : 'Sim'}</p>
              </div>
            </AdminSection>
          </div>

          <AdminSection title="G. Observações internas" description="Área pronta para edição auditada futura">
            <p className="text-sm text-slate-300">{participant.notes ? String(participant.notes) : 'Sem observações internas.'}</p>
          </AdminSection>

          <AdminSection title="Linha do tempo operacional" description="Mais recente para mais antigo">
            <div id="historico">
              {timelineItems.length ? (
                <AdminActivityTimeline items={timelineItems} />
              ) : (
                <AdminEmptyState title="Sem eventos operacionais" description="A linha do tempo aparecerá conforme ações forem registradas." />
              )}
            </div>
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
