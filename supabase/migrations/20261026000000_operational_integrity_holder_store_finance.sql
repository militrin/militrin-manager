-- Integridade operacional: titular por PIN, correlacao Loja, PIX comercial
-- da Loja, e divergencias financeiras abertas pela linha do tempo.
--
-- Nao emite ingresso. Nao cria cobranca. Nao estorna. Nao altera token/QR.
-- Nao aplica reparo pontual de producao (Graciele / R$60) nesta migration.

begin;

-- ============================================================
-- 1. Troca REAL de titular por PIN alinha registration_contact_id
--    (mesma semantica de admin_set_ticket_holder_contact).
--    Transferencia so de propriedade (holder_action=keep) nao passa por aqui.
-- ============================================================

create or replace function public.change_ticket_holder_by_pin_internal(
  p_ticket_id uuid,
  p_pin text,
  p_operation text,
  p_admin_override boolean default false,
  p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_oi public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_event public.events%rowtype;
  v_target public.customer_profiles%rowtype;
  v_current public.participants%rowtype;
  v_target_participant public.participants%rowtype;
  v_pin text := upper(regexp_replace(coalesce(p_pin, ''), '[^A-Za-z0-9]', '', 'g'));
  v_admin boolean;
  v_origin text;
  v_price record;
  v_priced_gender text;
  v_target_gender text;
  v_target_email text;
  v_target_participant_count integer;
  v_target_contact_id uuid;
  v_canonical_contact_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id = p_ticket_id and status <> 'cancelled' for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into v_oi from public.order_items where id = v_ticket.order_item_id for update;
  select * into v_order from public.orders where id = v_ticket.order_id for update;
  select * into v_event from public.events where id = v_ticket.event_id;
  v_admin := public.current_user_has_permission('participants.edit_basic')
    and public.user_can_access_organization(v_actor, v_ticket.organization_id);
  v_origin := case when v_admin and p_admin_override then 'admin' else 'portal' end;
  if v_origin = 'portal' and v_actor <> v_order.user_id
    and not exists (select 1 from public.participants p where p.id = v_oi.participant_id and p.user_id = v_actor) then
    raise exception 'Usuario sem acesso ao ingresso.';
  end if;
  if p_operation = 'holder_assigned' then
    if v_oi.participant_id is not null then raise exception 'Ingresso ja possui titular; use transferencia.'; end if;
    if not v_event.allow_holder_change and not (v_admin and p_admin_override) then
      raise exception 'Definicao de titular desabilitada para o evento.';
    end if;
  elsif p_operation = 'ticket_transferred' then
    if v_oi.participant_id is null then raise exception 'Ingresso sem titular; use definicao de titular.'; end if;
    if not v_event.allow_ticket_transfer and not (v_admin and p_admin_override) then
      raise exception 'Transferencia desabilitada para o evento.';
    end if;
  else
    raise exception 'Operacao invalida.';
  end if;

  select * into v_target from public.customer_profiles
    where public_pin = v_pin and coalesce(account_status, 'active') = 'active';
  if not found then raise exception 'PIN nao encontrado.'; end if;

  select id into v_target_contact_id from public.registration_contacts
    where organization_id = v_ticket.organization_id
      and cpf = regexp_replace(coalesce(v_target.cpf, ''), '\D', '', 'g');
  if v_target_contact_id is not null then
    perform public.assert_ticket_holder_contact_available(v_ticket.id, v_ticket.event_id, v_target_contact_id);
  end if;

  if v_oi.participant_id is not null then
    select * into v_current from public.participants where id = v_oi.participant_id;
  end if;
  v_target_gender := lower(trim(coalesce(v_target.gender, '')));
  select rbp.male_price, rbp.female_price into v_price
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_oi.batch_id and rbp.ticket_category_id = v_oi.ticket_category_id;
  if v_price.male_price is distinct from v_price.female_price then
    v_priced_gender := case
      when v_oi.unit_price = v_price.male_price and v_oi.unit_price is distinct from v_price.female_price then 'male'
      when v_oi.unit_price = v_price.female_price and v_oi.unit_price is distinct from v_price.male_price then 'female'
    end;
    if (v_priced_gender = 'male' and v_target_gender not in ('male', 'masculino', 'm'))
      or (v_priced_gender = 'female' and v_target_gender not in ('female', 'feminino', 'f'))
      or v_priced_gender is null then
      if not (v_admin and p_admin_override) then
        raise exception 'VALIDACAO_ADMINISTRATIVA: genero do usuario incompativel ou preco original ambiguo.';
      end if;
    end if;
  end if;
  if v_current.id is not null
    and nullif(trim(v_oi.shirt_type), '') is not null
    and lower(trim(coalesce(v_current.gender, ''))) <> v_target_gender
    and not (v_admin and p_admin_override) then
    raise exception 'VALIDACAO_ADMINISTRATIVA: camiseta existente exige revisao antes da transferencia.';
  end if;

  select count(*) into v_target_participant_count
    from public.participants
    where event_id = v_ticket.event_id and user_id = v_target.user_id;
  if v_target_participant_count > 1 then
    raise exception 'VALIDACAO_ADMINISTRATIVA: usuario possui multiplos cadastros de participante neste evento.';
  elsif v_target_participant_count = 1 then
    select * into strict v_target_participant
      from public.participants
      where event_id = v_ticket.event_id and user_id = v_target.user_id;
    if v_target_contact_id is not null and v_target_participant.registration_contact_id is null then
      update public.participants
        set registration_contact_id = v_target_contact_id
        where id = v_target_participant.id
        returning * into v_target_participant;
    end if;
  else
    select lower(trim(au.email)) into v_target_email from auth.users au where au.id = v_target.user_id;
    if nullif(v_target_email, '') is null then
      raise exception 'Conta de destino sem e-mail valido para criar participante.';
    end if;
    insert into public.participants (
      event_id, organization_id, registration_contact_id, user_id, full_name, cpf, birth_date, gender,
      phone, email, city, shirt_type, shirt_size, registration_status, ticket_category_id, batch_id
    ) values (
      v_ticket.event_id, v_ticket.organization_id, v_target_contact_id, v_target.user_id, v_target.full_name,
      v_target.cpf, v_target.birth_date, v_target.gender, v_target.phone, v_target_email, v_target.city,
      nullif(trim(coalesce(v_oi.shirt_type, '')), ''), nullif(trim(coalesce(v_oi.shirt_size, '')), ''),
      'confirmed', v_oi.ticket_category_id, v_oi.batch_id
    ) returning * into v_target_participant;
  end if;

  if v_current.user_id = v_target.user_id then
    raise exception 'Usuario ja e o titular do ingresso.';
  end if;

  v_canonical_contact_id := coalesce(v_target_contact_id, v_target_participant.registration_contact_id);

  update public.order_items set
    participant_id = v_target_participant.id,
    registration_contact_id = coalesce(v_canonical_contact_id, registration_contact_id),
    holder_full_name = v_target.full_name,
    ownership_status = case when p_operation = 'ticket_transferred' then 'transferred' else 'assigned' end,
    updated_at = now()
  where id = v_oi.id;

  -- Nao altera token/QR, owner_user_id, pedido, comprador ou pagamentos.
  update public.tickets set participant_id = v_target_participant.id where id = v_ticket.id;

  insert into public.ticket_holder_history (
    ticket_id, order_item_id, event_id, organization_id, operation,
    previous_participant_id, new_participant_id,
    previous_registration_contact_id, new_registration_contact_id,
    previous_user_id, new_user_id, actor_user_id, actor_origin, reason
  ) values (
    v_ticket.id, v_oi.id, v_ticket.event_id, v_ticket.organization_id, p_operation,
    v_current.id, v_target_participant.id,
    v_oi.registration_contact_id, v_canonical_contact_id,
    v_current.user_id, v_target.user_id, v_actor, v_origin,
    nullif(trim(coalesce(p_reason, '')), '')
  );
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    p_operation, 'tickets', v_ticket.id, v_ticket.event_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'previous_user_id', v_current.user_id,
      'new_user_id', v_target.user_id,
      'previous_registration_contact_id', v_oi.registration_contact_id,
      'new_registration_contact_id', v_canonical_contact_id,
      'actor_user_id', v_actor,
      'actor_origin', v_origin,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );
  return v_target_participant.id;
end;
$$;

revoke all on function public.change_ticket_holder_by_pin_internal(uuid, text, text, boolean, text)
  from public, anon, authenticated;

comment on function public.change_ticket_holder_by_pin_internal(uuid, text, text, boolean, text) is
  'Troca REAL de titular por PIN. Atualiza participant_id, holder e registration_contact_id. '
  'Nao altera owner, QR/token, comprador nem historico comercial. '
  'Transferencia so de propriedade (holder_action=keep) usa admin_transfer_ticket_ownership e nao chama esta funcao.';

-- ============================================================
-- 2. Detector: referencia cadastral residual, nao "titular atual"
-- ============================================================

create or replace function public.detect_integrity_legacy_holder_mismatch(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    'LEGACY_HOLDER_REFERENCE_MISMATCH'::text,
    'attention'::text,
    'titularidade'::text,
    'Referência cadastral do item desatualizada'::text,
    'O titular operacional do ingresso foi alterado, mas uma referência cadastral histórica do item ainda aponta para outro cadastro. Owner, QR e o pedido comercial original não são alterados por este check.'::text,
    oi.event_id,
    'order_item'::text,
    oi.id,
    'Abrir ingresso'::text,
    case when t.id is not null then '/ingressos/' || t.id else '/ingressos' end,
    jsonb_build_object(
      'order_item_registration_contact_id', oi.registration_contact_id,
      'participant_registration_contact_id', p.registration_contact_id,
      'operational_holder_name', rc_holder.full_name,
      'residual_contact_name', rc_residual.full_name,
      'owner_user_id', t.owner_user_id,
      'buyer_user_id', o.user_id,
      'has_holder_transfer_history', exists (
        select 1 from public.ticket_holder_history h
        where h.ticket_id = t.id
          and h.operation in ('ticket_transferred', 'holder_changed', 'holder_assigned')
      ),
      'event_name', e.name,
      'ticket_code', case when t.id is not null then '#' || upper(left(t.token::text, 8)) else null end
    )
  from public.order_items oi
  join public.events e on e.id = oi.event_id
  join public.participants p on p.id = coalesce(
    (select t0.participant_id from public.tickets t0 where t0.order_item_id = oi.id and t0.status <> 'cancelled' limit 1),
    oi.participant_id
  )
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  left join public.orders o on o.id = oi.order_id
  left join public.registration_contacts rc_holder on rc_holder.id = p.registration_contact_id
  left join public.registration_contacts rc_residual on rc_residual.id = oi.registration_contact_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.registration_contact_id is not null
    and p.registration_contact_id is not null
    and oi.registration_contact_id is distinct from p.registration_contact_id
    and oi.status not in ('cancelled', 'expired', 'refunded');
$$;

revoke all on function public.detect_integrity_legacy_holder_mismatch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_legacy_holder_mismatch(uuid, uuid) to service_role;

create or replace function public.get_operational_integrity_detector_codes()
returns table(code text, domain text, label text)
language sql
immutable
as $$
  select * from (values
    ('TICKET_NAMED_WITHOUT_CANONICAL_HOLDER', 'titularidade', 'Nenhum ingresso com nome informado sem titular vinculado'),
    ('DUPLICATE_ACTIVE_HOLDER', 'titularidade', 'Nenhum titular duplicado no mesmo evento'),
    ('LEGACY_HOLDER_REFERENCE_MISMATCH', 'titularidade', 'Nenhuma referência cadastral de item desatualizada'),
    ('PAID_ORDER_WITHOUT_TICKET', 'ingressos_pedidos', 'Nenhum pedido pago sem ingresso emitido'),
    ('TICKET_WITHOUT_ORDER_ITEM', 'ingressos_pedidos', 'Nenhum ingresso sem vínculo comercial'),
    ('SINGLE_TICKET_PRICE_NOT_CONFIRMED', 'categoria_preco', 'Preço do ingresso único confirmado em todos os eventos com vendas abertas'),
    ('NO_PURCHASABLE_CATEGORY_OPTION', 'categoria_preco', 'Sempre há opção de compra disponível quando as vendas estão abertas'),
    ('ORDER_ITEM_CATEGORY_EVENT_MISMATCH', 'categoria_preco', 'Nenhuma categoria ou lote de outro evento vinculado a um pedido'),
    ('TICKET_MISSING_REQUIRED_SHIRT_VARIANT', 'camisetas_kits', 'Nenhum ingresso com camiseta obrigatória sem tamanho definido'),
    ('TICKET_CANCELLED_WITH_PENDING_KIT_ITEM', 'camisetas_kits', 'Nenhum item de kit preso a um ingresso cancelado'),
    ('SHIRT_INVENTORY_DELIVERED_EXCEEDS_TOTAL', 'estoque', 'Estoque de camiseta consistente em todos os eventos'),
    ('TICKET_CANCELLED_WITH_CHECKIN', 'checkin_retirada', 'Nenhum check-in registrado em ingresso cancelado'),
    ('OPEN_BLOCKING_DATA_ISSUE', 'cadastros', 'Nenhuma pendência de cadastro bloqueando pagamento, emissão, check-in ou kit'),
    ('EVENT_SHIRT_KIT_WITHOUT_VARIANTS', 'configuracao_evento', 'Toda camiseta obrigatória tem tamanhos configurados')
  ) as t(code, domain, label);
$$;

revoke all on function public.get_operational_integrity_detector_codes() from public, anon;
grant execute on function public.get_operational_integrity_detector_codes() to authenticated;

-- ============================================================
-- 3. PIX da Loja: persistir prazo comercial na criacao
-- ============================================================

create or replace function public.start_store_order_payment_pix(
  p_store_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake',
  p_gateway_account_key text default null,
  p_gateway_environment text default null,
  p_checkout_url text default null,
  p_payment_method text default 'pix'
)
returns public.store_orders
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.store_orders%rowtype;
  v_provider text := lower(trim(coalesce(p_provider, 'fake')));
  v_method text := lower(trim(coalesce(p_payment_method, 'pix')));
  v_expires timestamptz;
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;
  if v_provider not in ('fake', 'asaas') then raise exception 'Provider de pagamento invalido.'; end if;
  if v_method not in ('pix', 'credit_card') then raise exception 'Metodo de pagamento invalido.'; end if;
  if p_gateway_environment is not null
    and p_gateway_environment not in ('sandbox', 'production') then
    raise exception 'Ambiente de gateway invalido.';
  end if;
  if p_gateway_account_key is not null
    and length(trim(p_gateway_account_key)) > 0
    and (
      length(trim(p_gateway_account_key)) > 64
      or trim(p_gateway_account_key) ~ '[$]|access_token|api[_-]?key'
    ) then
    raise exception 'Identificador de conta do gateway invalido.';
  end if;

  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta pendente de pagamento.'; end if;
  if v_order.payment_status = 'paid' then return v_order; end if;

  v_expires := case
    when v_method = 'pix' then public.pix_commercial_expires_at('pix', p_expires_at, now())
    else p_expires_at
  end;

  update public.store_orders set
    payment_method = v_method,
    pix_code = case when v_method = 'pix' then p_pix_code else pix_code end,
    pix_qrcode = case when v_method = 'pix' then p_pix_qrcode else pix_qrcode end,
    gateway_payment_id = p_gateway_payment_id,
    gateway_checkout_url = coalesce(p_checkout_url, gateway_checkout_url),
    expires_at = v_expires,
    provider = v_provider,
    gateway_account_key = nullif(trim(coalesce(p_gateway_account_key, '')), ''),
    gateway_environment = p_gateway_environment,
    last_gateway_attempt_status = null,
    updated_at = now()
  where id = p_store_order_id
  returning * into v_order;

  return v_order;
end;
$$;

revoke all on function public.start_store_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text) from public;
grant execute on function public.start_store_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text) to authenticated, service_role;

-- ============================================================
-- 4. Webhook Loja: correlacionar por gateway_payment_id, externalReference,
--    conta e vinculo persistido. Confirma pelo fluxo canonico. Nao emite ticket.
-- ============================================================

drop function if exists public.apply_store_order_gateway_status(text, text, text, text, text, text);
drop function if exists public.apply_store_order_gateway_status(text, text, text, text, text, text, text);

create or replace function public.apply_store_order_gateway_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_expected_gateway_account_key text default null,
  p_event_type text default null,
  p_external_reference text default null
)
returns table(store_order_id uuid, organization_id uuid, previous_status text, applied_status text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.store_orders%rowtype;
  v_expected text := nullif(trim(coalesce(p_expected_gateway_account_key, '')), '');
  v_event text := upper(trim(coalesce(p_event_type, '')));
  v_ext text := nullif(trim(coalesce(p_external_reference, '')), '');
  v_previous text;
  v_line record;
  v_matches integer;
  v_ext_uuid uuid;
begin
  if p_internal_status not in ('pending','processing','paid','expired','cancelled','refunded','chargeback','failed') then
    raise exception 'Status interno invalido: %', p_internal_status;
  end if;
  if nullif(trim(coalesce(p_provider_payment_id, '')), '') is null then
    raise exception 'provider_payment_id obrigatorio.';
  end if;

  select count(*) into v_matches
    from public.store_orders
    where gateway_payment_id = p_provider_payment_id;
  if v_matches > 1 then
    raise exception using errcode = 'P0001', message = 'STORE_ORDER_AMBIGUOUS';
  end if;

  select * into v_order
    from public.store_orders
    where gateway_payment_id = p_provider_payment_id
    for update;

  if not found and v_ext is not null then
    begin
      v_ext_uuid := v_ext::uuid;
    exception when invalid_text_representation then
      v_ext_uuid := null;
    end;
    if v_ext_uuid is not null then
      select * into v_order from public.store_orders where id = v_ext_uuid for update;
    end if;
    if not found then
      select * into v_order from public.store_orders where order_number = v_ext for update;
    end if;
    if found
      and v_order.gateway_payment_id is not null
      and v_order.gateway_payment_id is distinct from p_provider_payment_id then
      raise exception using errcode = 'P0001', message = 'STORE_ORDER_NOT_FOUND';
    end if;
  end if;

  if not found then
    raise exception using errcode = 'P0001', message = 'STORE_ORDER_NOT_FOUND';
  end if;

  if v_expected is not null
    and nullif(trim(coalesce(v_order.gateway_account_key, '')), '') is not null
    and v_order.gateway_account_key is distinct from v_expected then
    raise exception using errcode = 'P0001', message = 'GATEWAY_ACCOUNT_MISMATCH';
  end if;

  v_previous := v_order.payment_status;

  if v_event in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED') then
    p_internal_status := 'refunded';
  end if;

  if v_event = 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' then
    if v_order.status = 'pending' then
      update public.store_orders
      set last_gateway_attempt_status = 'refused', updated_at = now()
      where id = v_order.id;
    end if;
    return query select v_order.id, v_order.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status in ('pending', 'processing', 'chargeback', 'failed') then
    return query select v_order.id, v_order.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status = 'paid' then
    if v_order.status = 'confirmed' or v_order.payment_status = 'paid' then
      return query select v_order.id, v_order.organization_id, v_previous, 'paid';
      return;
    end if;
    -- Cancelamento local (usuario/admin/refund) nao e revivido.
    -- Pedido expirado com dinheiro recebido: pagamento tem precedencia.
    if v_order.status = 'cancelled' then
      insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
      values (
        'store_order_paid_after_terminal',
        'store_orders',
        v_order.id,
        v_order.event_id,
        jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id, 'status', v_order.status)
      );
      return query select v_order.id, v_order.organization_id, v_previous, v_previous;
      return;
    end if;

    update public.store_orders set
      status = 'confirmed',
      payment_status = 'paid',
      paid_at = now(),
      confirmed_at = now(),
      last_gateway_attempt_status = null,
      gateway_payment_id = coalesce(gateway_payment_id, p_provider_payment_id),
      gateway_account_key = coalesce(gateway_account_key, v_expected),
      provider = coalesce(nullif(provider, 'fake'), p_provider, provider),
      updated_at = now()
    where id = v_order.id;
    update public.store_order_items set status = 'confirmed'
    where store_order_id = v_order.id and status = 'reserved';
    update public.store_order_item_pickup_units set status = 'confirmed', updated_at = now()
    where store_order_item_id in (select id from public.store_order_items where store_order_id = v_order.id)
      and status = 'reserved';
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_confirmed',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object(
        'provider', p_provider,
        'provider_payment_id', p_provider_payment_id,
        'event_type', nullif(v_event, ''),
        'external_reference', v_ext
      )
    );
    return query select v_order.id, v_order.organization_id, v_previous, 'paid';
    return;
  end if;

  if v_order.status = 'confirmed' or v_order.payment_status = 'paid' then
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_gateway_status_ignored',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('incoming', p_internal_status, 'provider_payment_id', p_provider_payment_id)
    );
    return query select v_order.id, v_order.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status in ('expired', 'cancelled', 'failed') and v_order.status = 'pending' then
    for v_line in
      select * from public.store_order_items
      where store_order_id = v_order.id and status <> 'cancelled'
      for update
    loop
      perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
      update public.store_order_items set status = 'cancelled' where id = v_line.id;
      update public.store_order_item_pickup_units set status = 'cancelled', updated_at = now()
      where store_order_item_id = v_line.id and status <> 'delivered';
    end loop;

    update public.store_orders set
      status = case when p_internal_status = 'expired' then 'expired' else 'cancelled' end,
      payment_status = 'cancelled',
      cancelled_at = now(),
      updated_at = now()
    where id = v_order.id;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_'||p_internal_status,
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id)
    );
  elsif p_internal_status = 'refunded' then
    for v_line in
      select * from public.store_order_items
      where store_order_id = v_order.id and status <> 'cancelled'
      for update
    loop
      if v_line.status in ('reserved', 'confirmed') then
        perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
      end if;
      update public.store_order_items set status = 'cancelled' where id = v_line.id and status <> 'cancelled';
      update public.store_order_item_pickup_units set status = 'cancelled', updated_at = now()
      where store_order_item_id = v_line.id and status <> 'delivered';
    end loop;
    update public.store_orders set
      status = 'cancelled',
      payment_status = 'refunded',
      cancelled_at = coalesce(cancelled_at, now()),
      updated_at = now()
    where id = v_order.id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_refunded',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id)
    );
  end if;

  return query
    select v_order.id, v_order.organization_id, v_previous,
      (select payment_status from public.store_orders where id = v_order.id);
end;
$$;

revoke all on function public.apply_store_order_gateway_status(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_store_order_gateway_status(text, text, text, text, text, text, text) to service_role;

comment on function public.apply_store_order_gateway_status(text, text, text, text, text, text, text) is
  'Aplica status de gateway a store_orders. Localiza por gateway_payment_id, depois externalReference (id ou order_number) e valida account key quando ambas existem. Confirma item/estoque/auditoria. Nao emite ingresso.';

-- ============================================================
-- 5. Expiracao PIX da Loja pelo prazo comercial.
--    Pagamento recebido tem precedencia: nao expira pedido com
--    PAYMENT_RECEIVED/CONFIRMED no gateway, mesmo se ainda pending local.
-- ============================================================

create or replace function public.expire_expired_store_orders()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.store_orders%rowtype;
  v_line record;
  v_count integer := 0;
  v_commercial timestamptz;
begin
  for v_order in
    select * from public.store_orders
    where status = 'pending'
      and payment_status = 'pending'
      and expires_at is not null
    for update skip locked
  loop
    v_commercial := public.pix_commercial_expires_at(
      coalesce(v_order.payment_method, 'pix'),
      v_order.expires_at,
      v_order.created_at
    );
    if v_commercial is null or v_commercial > now() then
      continue;
    end if;

    -- Dinheiro recebido no gateway nao pode ser expirado localmente.
    if v_order.gateway_payment_id is not null and exists (
      select 1
      from public.payment_gateway_events e
      where e.provider_payment_id = v_order.gateway_payment_id
        and e.event_type in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH')
    ) then
      continue;
    end if;

    for v_line in
      select * from public.store_order_items
      where store_order_id = v_order.id and status <> 'cancelled'
      for update
    loop
      perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
      update public.store_order_items set status = 'cancelled' where id = v_line.id;
      update public.store_order_item_pickup_units set status = 'cancelled', updated_at = now()
      where store_order_item_id = v_line.id and status <> 'delivered';
    end loop;

    update public.store_orders set
      status = 'expired',
      payment_status = 'cancelled',
      cancelled_at = now(),
      updated_at = now()
    where id = v_order.id;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_expired',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object(
        'gateway_payment_id', v_order.gateway_payment_id,
        'provider', v_order.provider,
        'commercial_expires_at', v_commercial
      )
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.expire_expired_store_orders() from public;
grant execute on function public.expire_expired_store_orders() to authenticated, service_role;

-- ============================================================
-- 6. Divergencias financeiras ABERTAS consideram a linha do tempo.
--    Nao apaga webhook. Nao reescreve audit. So deixa de listar como aberta.
-- ============================================================

drop function if exists public.list_gateway_financial_divergences();

create or replace function public.list_gateway_financial_divergences()
returns table(
  id uuid,
  provider text,
  provider_payment_id text,
  event_type text,
  received_at timestamptz,
  last_error text,
  correlation_kind text,
  store_order_id uuid,
  store_order_number text,
  store_order_status text,
  store_payment_status text,
  customer_name text,
  amount numeric,
  action_href text,
  title text
)
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  with open_events as (
    select e.*
    from public.payment_gateway_events e
    where e.processing_status = 'financial_divergence'
      and not exists (
        select 1
        from public.payment_gateway_events later
        where later.provider_payment_id is not null
          and later.provider_payment_id = e.provider_payment_id
          and later.provider = e.provider
          and later.received_at > e.received_at
          and later.processing_status = 'processed'
          and later.event_type in (
            'PAYMENT_REFUNDED',
            'PAYMENT_DELETED',
            'PAYMENT_CHARGEBACK_REQUESTED'
          )
      )
      and not exists (
        select 1 from public.store_orders so
        where so.gateway_payment_id = e.provider_payment_id
          and so.payment_status in ('paid', 'refunded')
      )
      and not exists (
        select 1 from public.payments p
        where p.gateway_payment_id = e.provider_payment_id
          and p.payment_status in ('paid', 'refunded', 'chargeback')
      )
  )
  select
    e.id,
    e.provider,
    e.provider_payment_id,
    e.event_type,
    e.received_at,
    e.last_error,
    case when so.id is not null then 'store_order' else 'orphan' end,
    so.id,
    so.order_number,
    so.status,
    so.payment_status,
    rc.full_name,
    coalesce(
      so.final_amount,
      case
        when (e.payload #>> '{payment,value}') ~ '^[0-9]+(\.[0-9]+)?$'
        then (e.payload #>> '{payment,value}')::numeric
        else null
      end
    ),
    case when so.id is not null then '/loja/pedidos/' || so.id else null end,
    case
      when so.id is not null then 'Pagamento da Loja aguardando reconciliação'
      else 'Pagamento sem vínculo local'
    end
  from open_events e
  left join public.store_orders so
    on so.gateway_payment_id = e.provider_payment_id
  left join public.registration_contacts rc
    on rc.id = so.registration_contact_id
  order by e.received_at desc
  limit 200;
$$;

revoke all on function public.list_gateway_financial_divergences() from public, anon, authenticated;
grant execute on function public.list_gateway_financial_divergences() to service_role;

comment on function public.list_gateway_financial_divergences() is
  'Lista divergencias financeiras ABERTAS. Evento PAYMENT_REFUNDED processado posterior, '
  'store_order pago/estornado ou payment local pago/estornado deixam de ser acionaveis. '
  'Nao apaga webhook nem reescreve historico. Quando ha store_order correlacionavel, '
  'devolve tipo Loja (nao "pagamento sem vinculo local").';

commit;
