begin;

-- P0 financeiro: fecha RPCs legadas que permaneciam executaveis por anon
-- e padroniza as RPCs de cliente para falharem quando auth.uid() e NULL.
--
-- Funcoes internas continuam sem validacao de auth.uid(): elas sao chamadas
-- por outras SECURITY DEFINER e ficam acessiveis externamente apenas para
-- service_role por ACL explicita.

-- ============================================================
-- 1. PIX do pedido canonico: RPC de usuario, somente o comprador.
-- ============================================================
create or replace function public.start_order_payment_pix(
  p_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake'
)
returns table(payment_id uuid, order_id uuid, event_id uuid, amount numeric, discount_amount numeric, final_amount numeric, payment_method text, payment_status text, pix_code text, pix_qrcode text, gateway_payment_id text, expires_at timestamptz, paid_at timestamptz)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;
  if p_provider is not null and p_provider not in ('fake','asaas') then
    raise exception 'Provider de pagamento invalido.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;

  select * into v_payment
  from public.payments
  where public.payments.order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status = 'paid' then
    return query
    select
      v_payment.id, p_order_id, v_payment.event_id, v_payment.amount,
      coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
      v_payment.payment_method, v_payment.payment_status,
      v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
      v_payment.expires_at, v_payment.paid_at;
    return;
  end if;

  update public.payments
  set payment_method = 'pix',
      payment_status = 'pending',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
      provider = coalesce(p_provider, 'fake'),
      provider_status = null,
      expires_at = p_expires_at,
      paid_at = null,
      updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  update public.order_items oi
  set status = 'reserved',
      reservation_expires_at = p_expires_at,
      updated_at = now()
  where oi.order_id = p_order_id
    and status not in ('cancelled', 'expired', 'refunded', 'transferred');

  update public.orders
  set status = 'pending',
      cancelled_at = null
  where id = p_order_id;

  return query
  select
    v_payment.id, p_order_id, v_payment.event_id, v_payment.amount,
    coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
    v_payment.payment_method, v_payment.payment_status,
    v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
    v_payment.expires_at, v_payment.paid_at;
end;
$$;

revoke all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text)
from public, anon, authenticated, service_role;
grant execute on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text)
to authenticated;

-- ============================================================
-- 2. PIX participant-centric: proprio usuario ou financeiro da org.
-- ============================================================
create or replace function public.start_payment_pix(
  p_participant_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake'
)
returns table(payment_id uuid, participant_id uuid, event_id uuid, amount numeric, discount_amount numeric, final_amount numeric, payment_method text, payment_status text, pix_code text, pix_qrcode text, gateway_payment_id text, expires_at timestamptz, paid_at timestamptz)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_admin_allowed boolean := false;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;
  if p_provider is not null and p_provider not in ('fake','asaas') then
    raise exception 'Provider de pagamento invalido.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  v_admin_allowed :=
    public.user_can_access_organization(v_actor, v_participant.organization_id)
    and public.current_user_has_permission('finance.confirm_payment');

  if v_participant.user_id is distinct from v_actor and not v_admin_allowed then
    raise exception 'Sem permissao para alterar pagamento deste participante.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  if v_payment.organization_id is distinct from v_participant.organization_id then
    raise exception 'Pagamento diverge da organizacao do participante.';
  end if;

  if v_payment.payment_status = 'paid' then
    return query
    select
      v_payment.id, v_payment.participant_id, v_payment.event_id, v_payment.amount,
      coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
      v_payment.payment_method, v_payment.payment_status,
      v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
      v_payment.expires_at, v_payment.paid_at;
    return;
  end if;

  update public.payments
  set payment_method = 'pix',
      payment_status = 'pending',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
      provider = coalesce(p_provider, 'fake'),
      provider_status = null,
      expires_at = p_expires_at,
      paid_at = null
  where id = v_payment.id
  returning * into v_payment;

  update public.participants
  set registration_status = 'pending',
      reservation_status = 'pending',
      reservation_expires_at = p_expires_at,
      updated_at = now()
  where id = p_participant_id
    and reservation_status <> 'confirmed';

  insert into public.audit_logs(action, entity_type, entity_id, details, event_id)
  values (
    'payment_pix_started',
    'payments',
    v_payment.id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'participant_id', p_participant_id,
      'expires_at', p_expires_at,
      'gateway_payment_id', p_gateway_payment_id,
      'provider', coalesce(p_provider, 'fake')
    ),
    v_participant.event_id
  );

  return query
  select
    v_payment.id, v_payment.participant_id, v_payment.event_id, v_payment.amount,
    coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
    v_payment.payment_method, v_payment.payment_status,
    v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
    v_payment.expires_at, v_payment.paid_at;
end;
$$;

revoke all on function public.start_payment_pix(uuid, text, text, text, timestamptz, text)
from public, anon, authenticated, service_role;
grant execute on function public.start_payment_pix(uuid, text, text, text, timestamptz, text)
to authenticated;

-- ============================================================
-- 3. Leitura financeira participant-centric com least privilege.
-- ============================================================
create or replace function public.get_participant_payment_details(p_participant_id uuid)
returns table(payment_id uuid, participant_id uuid, event_id uuid, event_name text, amount numeric, discount_amount numeric, final_amount numeric, payment_method text, payment_status text, pix_code text, pix_qrcode text, gateway_payment_id text, expires_at timestamptz, paid_at timestamptz, created_at timestamptz, updated_at timestamptz)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_admin_allowed boolean := false;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  v_admin_allowed :=
    public.user_can_access_organization(v_actor, v_participant.organization_id)
    and (
      public.current_user_has_permission('finance.view_amounts')
      or public.current_user_has_permission('finance.confirm_payment')
    );

  if v_participant.user_id is distinct from v_actor and not v_admin_allowed then
    raise exception 'Sem permissao para consultar este pagamento.';
  end if;

  return query
  select
    pay.id,
    pay.participant_id,
    pay.event_id,
    e.name,
    pay.amount,
    coalesce(pay.discount_amount, 0),
    coalesce(pay.final_amount, pay.amount),
    pay.payment_method,
    pay.payment_status,
    pay.pix_code,
    pay.pix_qrcode,
    pay.gateway_payment_id,
    pay.expires_at,
    pay.paid_at,
    pay.created_at,
    pay.updated_at
  from public.payments pay
  left join public.events e on e.id = pay.event_id
  where pay.participant_id = p_participant_id
    and pay.organization_id = v_participant.organization_id
  order by pay.created_at desc
  limit 1;
end;
$$;

revoke all on function public.get_participant_payment_details(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_participant_payment_details(uuid)
to authenticated;

-- Operacoes de retirada precisam somente do estado liquidado, nunca do PIX,
-- identificador externo ou valores.
create or replace function public.get_ticket_payment_operational_status(p_ticket_id uuid)
returns table(payment_status text)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if not public.current_user_has_permission('participants.view') then
    raise exception 'Sem permissao para consultar o estado operacional do pagamento.';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id;

  if not found
    or not public.user_can_access_organization(v_actor, v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;

  return query
  select coalesce(p.payment_status, 'pending')::text
  from public.payments p
  where p.order_id = v_ticket.order_id
  order by p.created_at desc
  limit 1;
end;
$$;

revoke all on function public.get_ticket_payment_operational_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_ticket_payment_operational_status(uuid)
to authenticated;

-- ============================================================
-- 4. Loja: usuario autenticado e ownership/RBAC com escopo da org.
-- ============================================================
create or replace function public.start_store_order_payment_pix(
  p_store_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz
)
returns public.store_orders
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.store_orders%rowtype;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  select * into v_order
  from public.store_orders
  where id = p_store_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;
  if v_order.status <> 'pending' then
    raise exception 'Pedido nao esta pendente de pagamento.';
  end if;

  update public.store_orders
  set payment_method = 'pix',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
      expires_at = p_expires_at,
      updated_at = now()
  where id = p_store_order_id
  returning * into v_order;

  return v_order;
end;
$$;

revoke all on function public.start_store_order_payment_pix(uuid, text, text, text, timestamptz)
from public, anon, authenticated, service_role;
grant execute on function public.start_store_order_payment_pix(uuid, text, text, text, timestamptz)
to authenticated;

create or replace function public.cancel_store_order(p_store_order_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.store_orders%rowtype;
  v_line record;
  v_admin_allowed boolean := false;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  select * into v_order
  from public.store_orders
  where id = p_store_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;

  v_admin_allowed :=
    public.user_can_access_organization(v_actor, v_order.organization_id)
    and public.current_user_has_permission('store.manage');

  if v_order.user_id is distinct from v_actor and not v_admin_allowed then
    raise exception 'Sem permissao para cancelar este pedido.';
  end if;
  if v_order.status = 'cancelled' then
    return;
  end if;
  if exists (
    select 1 from public.store_order_items
    where store_order_id = p_store_order_id and status = 'delivered'
  ) then
    raise exception 'Pedido possui item entregue; nao pode ser cancelado.';
  end if;
  if exists (
    select 1
    from public.store_order_item_pickup_units u
    join public.store_order_items soi on soi.id = u.store_order_item_id
    where soi.store_order_id = p_store_order_id and u.status = 'delivered'
  ) then
    raise exception 'Pedido possui unidade de item ja entregue; nao pode ser cancelado.';
  end if;

  for v_line in
    select * from public.store_order_items
    where store_order_id = p_store_order_id and status <> 'cancelled'
    for update
  loop
    perform public.release_store_item_reservation(
      v_line.store_item_id,
      v_line.variant_id,
      v_line.quantity
    );
    update public.store_order_items set status = 'cancelled' where id = v_line.id;
    update public.store_order_item_pickup_units
    set status = 'cancelled', updated_at = now()
    where store_order_item_id = v_line.id and status <> 'delivered';
  end loop;

  update public.store_orders
  set status = 'cancelled', cancelled_at = now(), updated_at = now()
  where id = p_store_order_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'store_order_cancelled',
    'store_orders',
    p_store_order_id,
    v_order.event_id,
    jsonb_build_object('actor_user_id', v_actor, 'reason', p_reason)
  );
end;
$$;

revoke all on function public.cancel_store_order(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.cancel_store_order(uuid, text)
to authenticated;

-- ============================================================
-- 5. Cancelamento participant-centric: dono ou financeiro da org.
-- ============================================================
create or replace function public.cancel_registration_payment(
  p_participant_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_admin_allowed boolean := false;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  v_admin_allowed :=
    public.user_can_access_organization(v_actor, v_participant.organization_id)
    and public.current_user_has_permission('finance.confirm_payment');

  if v_participant.user_id is distinct from v_actor and not v_admin_allowed then
    raise exception 'Sem permissao para cancelar este pagamento.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;
  if v_payment.organization_id is distinct from v_participant.organization_id then
    raise exception 'Pagamento diverge da organizacao do participante.';
  end if;
  if v_payment.payment_status = 'paid' then
    raise exception 'Pagamento pago nao pode ser cancelado por esta rotina.';
  end if;

  update public.payments
  set payment_status = 'cancelled',
      expires_at = null
  where id = v_payment.id;

  if v_participant.reservation_status = 'pending' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if found and v_inventory.reserved_quantity > 0 then
      update public.shirt_inventory
      set reserved_quantity = reserved_quantity - 1,
          updated_at = now()
      where id = v_inventory.id
        and reserved_quantity > 0;

      insert into public.inventory_movements(
        event_id, inventory_id, movement_type, quantity, notes
      )
      values (
        v_participant.event_id,
        v_inventory.id,
        'adjustment',
        1,
        format('Cancelamento de pagamento para participante %s.', v_participant.full_name)
      );
    end if;
  end if;

  update public.participants
  set registration_status = 'cancelled',
      reservation_status = 'released',
      reservation_released_at = now(),
      reservation_expires_at = null,
      updated_at = now()
  where id = p_participant_id;

  insert into public.audit_logs(action, entity_type, entity_id, details, event_id)
  values (
    'payment_cancelled',
    'participants',
    p_participant_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'reason', nullif(trim(coalesce(p_reason, '')), ''),
      'payment_id', v_payment.id
    ),
    v_participant.event_id
  );

  return true;
end;
$$;

revoke all on function public.cancel_registration_payment(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.cancel_registration_payment(uuid, text)
to authenticated;

-- ============================================================
-- 6. Simuladores e primitivas de emissao nao sao endpoints de cliente.
-- ============================================================
revoke all on function public.simulate_order_payment_paid(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.simulate_order_payment_paid(uuid, text)
to service_role;

revoke all on function public.simulate_payment_paid(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.simulate_payment_paid(uuid, text)
to service_role;

revoke all on function public.simulate_store_order_payment(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.simulate_store_order_payment(uuid, text)
to service_role;

revoke all on function public.confirm_order_payment_and_issue_tickets(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.confirm_order_payment_and_issue_tickets(uuid)
to service_role;

revoke all on function public.confirm_order_item_and_issue_ticket(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.confirm_order_item_and_issue_ticket(uuid)
to service_role;

revoke all on function public.confirm_registration_payment(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.confirm_registration_payment(uuid)
to service_role;

revoke all on function public.confirm_order_and_issue_ticket(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.confirm_order_and_issue_ticket(uuid)
to service_role;

revoke all on function public.confirm_store_order_payment(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.confirm_store_order_payment(uuid)
to authenticated, service_role;

-- Deliberadamente nao altera ALTER DEFAULT PRIVILEGES. O baseline concede
-- EXECUTE futuro a anon/authenticated e migrations posteriores combinam
-- grants implicitos e explicitos. Mudar o default nesta correcao P0 teria
-- efeito apenas em objetos futuros e exige uma migracao de hardening propria.

commit;
