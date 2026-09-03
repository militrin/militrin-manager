begin;

-- Release Gate #1 (PIX/Asaas). NAO altera a migration 44.
-- 1) Origem logica da cobranca (troca de conta Asaas sem migrar cobrancas antigas).
-- 2) Trava de geracao de PIX para evitar cobranca duplicada por duplo clique.
-- 3) Emissao administrativa visivel de pedido ja pago sem ingresso (pagamento tardio).
-- 4) Detector de integridade passa a enxergar pagamento pago com item ainda expirado/reservado.

alter table public.payments
  add column if not exists gateway_account_key text,
  add column if not exists pix_generation_started_at timestamptz;

comment on column public.payments.gateway_account_key is
  'Rotulo logico opaco da configuracao/conta do gateway (env ASAAS_ACCOUNT_KEY, ex. um identificador curto). Nunca e a API key, token ou segredo. Cobrancas antigas sem valor = origem desconhecida/legacy -- nao reconciliar na conta ativa.';

comment on column public.payments.pix_generation_started_at is
  'Trava curta para claim de geracao de PIX. Limpa quando a cobranca e persistida ou apos timeout de 45s.';

-- ============================================================
-- start_order_payment_pix: carimba origem + limpa trava de geracao.
-- Recria a assinatura com parametro extra (default) sem enfraquecer ACL.
-- ============================================================
drop function if exists public.start_order_payment_pix(uuid, text, text, text, timestamptz, text);

create or replace function public.start_order_payment_pix(
  p_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake',
  p_gateway_account_key text default null
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
  if p_gateway_account_key is not null
    and length(trim(p_gateway_account_key)) > 0
    and (
      length(trim(p_gateway_account_key)) > 64
      or trim(p_gateway_account_key) ~ '[$]|access_token|api[_-]?key'
    ) then
    raise exception 'Identificador de conta do gateway invalido.';
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
      gateway_account_key = coalesce(nullif(trim(p_gateway_account_key), ''), gateway_account_key),
      pix_generation_started_at = null,
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
    and status not in ('cancelled', 'refunded', 'transferred');

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

revoke all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text)
to authenticated;

-- ============================================================
-- Claim atomico antes de chamar o gateway.
-- ============================================================
create or replace function public.claim_order_pix_generation(p_order_id uuid)
returns jsonb
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

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;

  select * into v_payment
  from public.payments
  where order_id = p_order_id
  order by created_at desc
  limit 1
  for update;
  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status = 'paid' then
    return jsonb_build_object('action', 'paid', 'payment_id', v_payment.id);
  end if;

  if v_payment.payment_status = 'pending'
    and coalesce(v_payment.pix_code, '') <> ''
    and v_payment.expires_at is not null
    and v_payment.expires_at > now() then
    return jsonb_build_object(
      'action', 'reuse',
      'payment_id', v_payment.id,
      'gateway_payment_id', v_payment.gateway_payment_id
    );
  end if;

  if v_payment.pix_generation_started_at is not null
    and v_payment.pix_generation_started_at > now() - interval '45 seconds' then
    raise exception 'PIX_GENERATION_IN_PROGRESS';
  end if;

  update public.payments
  set pix_generation_started_at = now(),
      updated_at = now()
  where id = v_payment.id;

  return jsonb_build_object(
    'action', 'claim',
    'payment_id', v_payment.id,
    'organization_id', v_payment.organization_id,
    'previous_provider', v_payment.provider,
    'previous_gateway_payment_id', v_payment.gateway_payment_id,
    'previous_gateway_account_key', v_payment.gateway_account_key
  );
end;
$$;

revoke all on function public.claim_order_pix_generation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_order_pix_generation(uuid) to authenticated;

create or replace function public.release_order_pix_generation(p_order_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return;
  end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;

  update public.payments
  set pix_generation_started_at = null,
      updated_at = now()
  where order_id = p_order_id
    and payment_status is distinct from 'paid';
end;
$$;

revoke all on function public.release_order_pix_generation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_order_pix_generation(uuid) to authenticated;

-- ============================================================
-- Emissao contingente: pagamento ja paid, ingresso ainda nao emitido.
-- Restaura itens expirados para que confirm_order_payment os enxergue.
-- ============================================================
create or replace function public.admin_issue_tickets_for_paid_order(
  p_order_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_issued int := 0;
begin
  if v_actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 8 then
    raise exception 'Informe um motivo com pelo menos 8 caracteres.';
  end if;
  if not public.current_user_has_permission('finance.confirm_payment') then
    raise exception 'Sem permissao para emitir ingressos de pedido pago.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;
  if not public.user_can_access_organization(v_actor, v_order.organization_id) then
    raise exception 'Sem acesso a esta organizacao.';
  end if;

  select * into v_payment
  from public.payments
  where order_id = p_order_id
  order by created_at desc
  limit 1
  for update;
  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;
  if v_payment.payment_status is distinct from 'paid' then
    raise exception 'So e possivel emitir por esta acao quando o pagamento ja esta confirmado.';
  end if;

  -- Restaura linhas expiradas (ingresso e produto) para o confirmador
  -- canonico enxerga-las. Produto nunca gera ticket (confirm_order_item
  -- retorna null). Itens cancelled/refunded permanecem intocados.
  update public.order_items
  set status = 'reserved',
      reservation_expires_at = null,
      updated_at = now()
  where order_id = p_order_id
    and status = 'expired';

  perform public.confirm_order_payment_and_issue_tickets(p_order_id);

  select count(*)::int into v_issued
  from public.tickets t
  where t.order_id = p_order_id
    and t.status is distinct from 'cancelled';

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'admin_issue_tickets_for_paid_order',
    'orders',
    p_order_id,
    v_order.event_id,
    jsonb_build_object(
      'payment_id', v_payment.id,
      'reason', trim(p_reason),
      'active_ticket_count', v_issued,
      'actor_id', v_actor
    )
  );

  return jsonb_build_object('success', true, 'active_ticket_count', v_issued);
end;
$$;

revoke all on function public.admin_issue_tickets_for_paid_order(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_issue_tickets_for_paid_order(uuid, text) to authenticated;

-- Fila operacional: pedidos pagos sem ingresso ativo (inclui item ainda expirado/reservado).
drop function if exists public.list_paid_orders_awaiting_ticket_issue();

create or replace function public.list_paid_orders_awaiting_ticket_issue()
returns table(
  order_id uuid,
  order_number text,
  display_number text,
  event_id uuid,
  event_name text,
  buyer_name text,
  holder_summary text,
  paid_at timestamptz,
  expected_ticket_items integer,
  missing_ticket_items integer,
  pending_reason text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;
  if not (
    public.current_user_has_permission('finance.view')
    or public.current_user_has_permission('finance.confirm_payment')
    or public.current_user_has_permission('integrity.view')
  ) then
    raise exception 'Sem permissao para listar divergencias de PIX.';
  end if;

  return query
  select
    o.id,
    o.order_number,
    o.display_number::text,
    o.event_id,
    e.name,
    max(coalesce(cp.full_name, ''))::text as buyer_name,
    max(coalesce(nullif(trim(coalesce(rc.full_name, oi.holder_full_name)), ''), 'Titular nao definido'))::text as holder_summary,
    pay.paid_at,
    (
      select count(*)::int
      from public.order_items eoi
      where eoi.order_id = o.id
        and eoi.item_kind = 'ticket'
        and eoi.status not in ('cancelled', 'refunded')
    ) as expected_ticket_items,
    count(*)::int as missing_ticket_items,
    case
      when exists (
        select 1
        from public.audit_logs al
        where al.entity_type = 'payments'
          and al.entity_id = pay.id
          and al.action like 'payment_paid_after_%'
      ) then 'Pagamento confirmado apos expiracao local'
      else 'Pedido pago sem ingresso emitido'
    end as pending_reason
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  join lateral (
    select p.id, p.paid_at
    from public.payments p
    where p.order_id = o.id
      and p.payment_status = 'paid'
    order by p.paid_at desc nulls last, p.created_at desc
    limit 1
  ) pay on true
  left join public.customer_profiles cp on cp.user_id = o.user_id
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  where public.user_can_access_organization(v_actor, o.organization_id)
    and oi.item_kind = 'ticket'
    and oi.status not in ('cancelled', 'refunded')
    and t.id is null
    and not exists (
      select 1 from public.tickets ct
      where ct.order_item_id = oi.id
        and ct.status = 'cancelled'
        and ct.cancellation_replacement_required = false
    )
  group by o.id, o.order_number, o.display_number, o.event_id, e.name, pay.id, pay.paid_at
  order by pay.paid_at desc nulls last;
end;
$$;

revoke all on function public.list_paid_orders_awaiting_ticket_issue() from public, anon, authenticated, service_role;
grant execute on function public.list_paid_orders_awaiting_ticket_issue() to authenticated;

-- Detector: pagamento pago + item de ingresso sem ticket ativo, inclusive
-- quando o item ainda esta reserved/expired apos pagamento tardio.
create or replace function public.detect_integrity_paid_order_without_ticket(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'PAID_ORDER_WITHOUT_TICKET'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Pedido pago sem ingresso emitido'::text,
    'O pagamento deste pedido foi confirmado, mas o ingresso correspondente não foi emitido.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir pedido'::text, '/inscricoes/pedido/' || o.id,
    jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'order_item_status', oi.status,
      'event_name', e.name, 'holder_name', coalesce(rc.full_name, oi.holder_full_name),
      'final_amount', oi.final_amount
    )
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.item_kind = 'ticket'
    and oi.status not in ('cancelled', 'refunded')
    and exists (select 1 from public.payments pay where (pay.order_id = o.id or pay.id = o.payment_id) and pay.payment_status = 'paid')
    and t.id is null
    and not exists (
      select 1 from public.tickets ct
      where ct.order_item_id = oi.id and ct.status = 'cancelled' and ct.cancellation_replacement_required = false
    );
$$;

revoke all on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) to service_role;

commit;
