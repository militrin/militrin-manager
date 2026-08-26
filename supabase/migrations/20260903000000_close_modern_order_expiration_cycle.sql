begin;

-- P0 antes do Asaas real -- fecha o ciclo de expiracao do fluxo moderno
-- (orders/order_items/payments), que ate agora so existia pela metade:
--
-- 1) expire_stale_order_payments() (20260898000000) sabe varrer payments
--    'pending' vencidos e cascatear para order_items/orders, mas NUNCA era
--    chamada por nada -- nenhum cron, nenhum webhook, nenhuma Server Action.
--    Confirmado em dado real de producao: o pedido MIL-2026-00001069 tem
--    payments.payment_status='expired' (setado pela rotina LEGADA
--    release_expired_reservations(), que so mexe em payments/participants)
--    mas orders.status continua 'pending' e order_items.status continua
--    'reserved' -- exatamente o estado inconsistente que este ciclo evita.
--
-- 2) mesmo que a #1 fosse chamada, _apply_terminal_order_payment_status()
--    (mesma migration 20260898000000) nunca libera a vaga: get_event_ticket_
--    categories() (linha ~7250 do baseline) calcula available_slots
--    contando exclusivamente public.participants.reservation_status IN
--    ('pending','confirmed') -- nunca conta order_items. Confirmado em dado
--    real: o order_item do pedido 00001081 (ainda 'reserved', prazo ja
--    vencido) tem participant_id apontando pra um participants row com
--    reservation_status='pending' -- ou seja, todo pedido moderno tambem
--    reserva vaga via essa mesma linha legada de participants. Sem tocar
--    nela, expirar o payment/order/order_items deixaria a vaga presa pra
--    sempre ("reserva correspondente" nunca liberada), mesmo com os status
--    financeiros corretos.
--
-- A correcao cobre as duas pontas: (a) redefine
-- _apply_terminal_order_payment_status pra tambem liberar a reserva do
-- participants ligado, so no caminho 'expired' (o unico que
-- expire_stale_order_payments() aciona -- 'cancelled'/'refunded' continuam
-- fora de escopo aqui, sao decisao de produto separada sobre reabrir vaga
-- apos cancelamento/estorno); (b) agenda expire_stale_order_payments() via
-- pg_cron, que este projeto ja tem habilitado (CREATE EXTENSION pg_cron no
-- baseline) -- reaproveitado, nao criada infra nova.

-- ============================================================
-- 1. _apply_terminal_order_payment_status -- adiciona liberacao da reserva
--    de participants (capacidade de categoria) no caminho 'expired'.
--    Idempotente: so mexe em participant com reservation_status ainda
--    'pending' (nunca sobrescreve um estado ja resolvido por outro fluxo).
-- ============================================================
create or replace function public._apply_terminal_order_payment_status(p_payment_id uuid, p_target_status text)
returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_payment public.payments%rowtype;
begin
  if p_target_status not in ('expired','cancelled','refunded') then
    raise exception 'Status terminal invalido: %', p_target_status;
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then return; end if;

  update public.payments set
    payment_status = p_target_status,
    refunded_at = case when p_target_status = 'refunded' then coalesce(refunded_at, now()) else refunded_at end,
    expires_at = case when p_target_status in ('expired','cancelled') then null else expires_at end,
    updated_at = now()
  where id = p_payment_id;

  if v_payment.order_id is null then
    -- payment legado (participant-based) -- fora do escopo desta cascata.
    return;
  end if;

  if p_target_status = 'refunded' then
    update public.order_items set status = 'refunded', reservation_expires_at = null, updated_at = now()
    where order_id = v_payment.order_id and status not in ('cancelled','expired','refunded','transferred');

    -- Cancela so tickets ATIVOS -- ticket ja usado preserva historico (nao e
    -- reaberto nem apagado; uma reversao de check-in e decisao administrativa
    -- separada). Ticket ja cancelado permanece cancelado.
    update public.tickets set status = 'cancelled', cancelled_at = now()
    where order_id = v_payment.order_id and status = 'active';

    update public.orders set status = 'refunded' where id = v_payment.order_id;
  else
    update public.order_items set status = p_target_status, reservation_expires_at = null, updated_at = now()
    where order_id = v_payment.order_id and status = 'reserved';

    update public.orders set status = p_target_status where id = v_payment.order_id and status = 'pending';

    if p_target_status = 'expired' then
      -- Mesma vaga que get_event_ticket_categories() conta via
      -- participants.reservation_status -- sem isto a categoria fica
      -- "cheia" pra sempre mesmo com o pedido corretamente expirado.
      update public.participants pt
      set reservation_status = 'expired',
          registration_status = 'cancelled',
          reservation_released_at = now()
      where pt.reservation_status = 'pending'
        and pt.id in (
          select oi.participant_id
          from public.order_items oi
          where oi.order_id = v_payment.order_id
            and oi.participant_id is not null
            and oi.status = 'expired'
        );
    end if;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('payment_'||p_target_status, 'payments', p_payment_id, v_payment.event_id,
    jsonb_build_object('order_id', v_payment.order_id, 'provider', v_payment.provider, 'organization_id', v_payment.organization_id));
end;
$$;

-- ============================================================
-- 2. Aciona expire_stale_order_payments() de fato -- pg_cron ja habilitado
--    (CREATE EXTENSION IF NOT EXISTS pg_cron, baseline 20260815001914).
--    cron.schedule com nome fixo e upsert: reaplicar esta migration
--    reagenda o mesmo job em vez de duplicar. A funcao ja foi projetada pra
--    execucao sem sessao (auth.uid() null quando chamada pelo worker do
--    pg_cron pula a checagem de permissao, que so vale pra chamada manual
--    via RPC autenticado) e roda como SECURITY DEFINER (dono da funcao),
--    entao nao precisa de grant extra pro role que o pg_cron usa.
--    2 minutos: intervalo curto o suficiente pra fechar o ciclo bem antes de
--    qualquer janela tipica de PIX (15-30 min), sem varrer a cada poucos
--    segundos.
-- ============================================================
select cron.schedule(
  'expire_stale_order_payments_every_2m',
  '*/2 * * * *',
  $$select public.expire_stale_order_payments();$$
);

commit;
