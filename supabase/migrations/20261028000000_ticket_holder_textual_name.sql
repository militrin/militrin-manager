-- Titular do ingresso passa a ser nome textual livre (order_items.holder_full_name).
-- Aditivo: nao apaga FKs, RPCs, historico nem Cadastros/participants existentes.
-- Nao altera owner_user_id, orders.user_id, Auth, kit, pulseira, check-in ou QR.

begin;

-- ============================================================
-- 1. Historico futuro guarda o nome textual
-- ============================================================

alter table public.ticket_holder_history
  add column if not exists previous_holder_name text,
  add column if not exists new_holder_name text;

comment on column public.ticket_holder_history.previous_holder_name is
  'Snapshot textual do titular anterior. Nulo em linhas historicas anteriores a 20261028000000.';
comment on column public.ticket_holder_history.new_holder_name is
  'Snapshot textual do titular novo. Nulo em remocao e em linhas historicas anteriores a 20261028000000.';

-- ============================================================
-- 2. Backfill: preenche holder_full_name SOMENTE onde estiver vazio
-- ============================================================

update public.order_items oi
set
  holder_full_name = src.resolved_name,
  updated_at = now()
from (
  select
    oi2.id,
    coalesce(
      nullif(trim(p.full_name), ''),
      nullif(trim(rc.full_name), ''),
      nullif(trim(tp.full_name), '')
    ) as resolved_name
  from public.order_items oi2
  left join public.participants p on p.id = oi2.participant_id
  left join public.registration_contacts rc on rc.id = oi2.registration_contact_id
  left join public.tickets t on t.order_item_id = oi2.id
  left join public.participants tp on tp.id = t.participant_id
) src
where oi.id = src.id
  and nullif(trim(coalesce(oi.holder_full_name, '')), '') is null
  and src.resolved_name is not null;

-- Nome textual e titular valido: fecha pendencia legado de "identidade insuficiente".
update public.participant_data_issues
set
  status = 'resolved',
  resolved_at = coalesce(resolved_at, now()),
  updated_at = now()
where status = 'open'
  and issue_type = 'insufficient_named_holder_identity';

-- ============================================================
-- 3. Nucleo atomico: grava nome, desvincula titular legado, preserva owner
-- ============================================================

create or replace function public.apply_ticket_holder_name_internal(
  p_ticket_id uuid,
  p_holder_name text,
  p_reason_code text,
  p_reason_text text,
  p_actor_origin text,
  p_require_event_flags boolean
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_item public.order_items%rowtype;
  v_event public.events%rowtype;
  v_previous public.participants%rowtype;
  v_previous_contact_id uuid;
  v_previous_user_id uuid;
  v_previous_name text;
  v_name text := nullif(trim(coalesce(p_holder_name, '')), '');
  v_reason_code text := trim(coalesce(p_reason_code, ''));
  v_reason_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_operation text;
  v_owner_user_id uuid;
  v_order_user_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_actor_origin not in ('admin', 'portal') then raise exception 'Origem do ator invalida.'; end if;
  if v_reason_code not in (
    'registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
    'issuance_error','system_error','data_regularization','other','legacy_unclassified'
  ) then
    raise exception 'Motivo de alteracao invalido.';
  end if;
  if v_reason_code = 'other' and v_reason_text is null then
    raise exception 'Descreva o motivo da alteracao.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  v_owner_user_id := v_ticket.owner_user_id;

  if p_actor_origin = 'admin' then
    if not public.user_can_access_organization(v_actor, v_ticket.organization_id) then
      raise exception 'Ingresso invalido ou sem acesso.';
    end if;
  else
    if v_ticket.owner_user_id is distinct from v_actor then
      raise exception 'Somente o proprietario pode alterar o nome do titular.';
    end if;
  end if;

  if v_ticket.status in ('cancelled', 'canceled', 'void', 'voided') then
    raise exception 'Ingresso cancelado nao pode ter titular alterado.';
  end if;
  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Ingresso ja utilizado nao pode ter titular alterado.';
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  if not found then raise exception 'Evento do ingresso nao encontrado.'; end if;

  select * into strict v_item from public.order_items where id = v_ticket.order_item_id for update;
  select o.user_id into v_order_user_id from public.orders o where o.id = v_ticket.order_id;

  if coalesce(v_item.participant_id, v_ticket.participant_id) is not null then
    select * into v_previous from public.participants where id = coalesce(v_item.participant_id, v_ticket.participant_id);
  end if;
  v_previous_contact_id := coalesce(v_item.registration_contact_id, v_previous.registration_contact_id);
  v_previous_user_id := v_previous.user_id;
  v_previous_name := coalesce(
    nullif(trim(coalesce(v_item.holder_full_name, '')), ''),
    nullif(trim(coalesce(v_previous.full_name, '')), '')
  );

  if p_require_event_flags then
    if v_previous_name is null then
      if not v_event.allow_holder_change then
        raise exception 'Definicao de titular desabilitada para o evento.';
      end if;
    else
      if not v_event.allow_ticket_transfer then
        raise exception 'Alteracao de titular desabilitada para o evento.';
      end if;
    end if;
  end if;

  if p_holder_name is null then
    if v_previous_name is null
      and v_item.participant_id is null
      and v_item.registration_contact_id is null
      and v_ticket.participant_id is null then
      return jsonb_build_object(
        'success', true, 'changed', false, 'ticket_id', v_ticket.id,
        'holder_full_name', null, 'owner_user_id', v_ticket.owner_user_id
      );
    end if;
    v_operation := 'holder_removed';
    update public.order_items
    set
      holder_full_name = null,
      participant_id = null,
      registration_contact_id = null,
      ownership_status = 'unassigned',
      updated_at = now()
    where id = v_item.id;
  else
    if v_name is null then raise exception 'Informe o nome do titular.'; end if;
    if char_length(v_name) > 200 then raise exception 'Nome do titular excede o limite.'; end if;
    if v_previous_name is not distinct from v_name
      and v_item.participant_id is null
      and v_item.registration_contact_id is null
      and v_ticket.participant_id is null then
      return jsonb_build_object(
        'success', true, 'changed', false, 'ticket_id', v_ticket.id,
        'holder_full_name', v_name, 'owner_user_id', v_ticket.owner_user_id
      );
    end if;
    v_operation := case when v_previous_name is null then 'holder_assigned' else 'holder_changed' end;
    update public.order_items
    set
      holder_full_name = v_name,
      participant_id = null,
      registration_contact_id = null,
      ownership_status = 'assigned',
      updated_at = now()
    where id = v_item.id;
  end if;

  update public.tickets
  set participant_id = null
  where id = v_ticket.id
    and owner_user_id is not distinct from v_owner_user_id;

  if exists (
    select 1 from public.tickets t
    where t.id = v_ticket.id and t.owner_user_id is distinct from v_owner_user_id
  ) then
    raise exception 'Propriedade do ingresso nao pode ser alterada por esta operacao.';
  end if;
  if exists (
    select 1 from public.orders o
    where o.id = v_ticket.order_id and o.user_id is distinct from v_order_user_id
  ) then
    raise exception 'Comprador do pedido nao pode ser alterado por esta operacao.';
  end if;

  insert into public.ticket_holder_history(
    ticket_id, order_item_id, event_id, organization_id, operation,
    previous_participant_id, new_participant_id,
    previous_registration_contact_id, new_registration_contact_id,
    previous_user_id, new_user_id,
    previous_holder_name, new_holder_name,
    actor_user_id, actor_origin, reason, reason_code, reason_text
  ) values (
    v_ticket.id, v_item.id, v_ticket.event_id, v_ticket.organization_id, v_operation,
    v_previous.id, null,
    v_previous_contact_id, null,
    v_previous_user_id, null,
    v_previous_name, v_name,
    v_actor, p_actor_origin, v_reason_text, v_reason_code, v_reason_text
  );

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    v_operation, 'tickets', v_ticket.id, v_ticket.event_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'previous_holder_name', v_previous_name,
      'new_holder_name', v_name,
      'previous_participant_id', v_previous.id,
      'new_participant_id', null,
      'previous_registration_contact_id', v_previous_contact_id,
      'new_registration_contact_id', null,
      'previous_user_id', v_previous_user_id,
      'new_user_id', null,
      'owner_user_id', v_owner_user_id,
      'actor_user_id', v_actor,
      'reason_code', v_reason_code,
      'reason_text', v_reason_text
    )
  );

  return jsonb_build_object(
    'success', true,
    'changed', true,
    'ticket_id', v_ticket.id,
    'holder_full_name', v_name,
    'owner_user_id', v_owner_user_id,
    'operation', v_operation
  );
end;
$$;

revoke all on function public.apply_ticket_holder_name_internal(uuid, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.apply_ticket_holder_name_internal(uuid, text, text, text, text, boolean)
  to service_role;

create or replace function public.admin_set_ticket_holder_name(
  p_ticket_id uuid,
  p_holder_name text,
  p_reason_code text default null,
  p_reason_text text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_reason_code text := nullif(trim(coalesce(p_reason_code, '')), '');
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para alterar titular.';
  end if;
  if p_holder_name is null then
    if v_reason_code is null then raise exception 'Motivo de alteracao invalido.'; end if;
  else
    v_reason_code := coalesce(v_reason_code, 'administrative_adjustment');
  end if;
  return public.apply_ticket_holder_name_internal(
    p_ticket_id, p_holder_name, v_reason_code, p_reason_text, 'admin', false
  );
end;
$$;

revoke all on function public.admin_set_ticket_holder_name(uuid, text, text, text)
  from public, anon;
grant execute on function public.admin_set_ticket_holder_name(uuid, text, text, text)
  to authenticated, service_role;

create or replace function public.set_ticket_holder_name_for_owner(
  p_ticket_id uuid,
  p_holder_name text
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if nullif(trim(coalesce(p_holder_name, '')), '') is null then
    raise exception 'Informe o nome do titular.';
  end if;
  return public.apply_ticket_holder_name_internal(
    p_ticket_id, p_holder_name, 'holder_request', null, 'portal', true
  );
end;
$$;

revoke all on function public.set_ticket_holder_name_for_owner(uuid, text)
  from public, anon;
grant execute on function public.set_ticket_holder_name_for_owner(uuid, text)
  to authenticated, service_role;

comment on function public.admin_set_ticket_holder_name(uuid, text, text, text) is
  'Altera somente o nome textual do titular. Nao cria Cadastro/participant/Auth e nao altera owner_user_id.';
comment on function public.set_ticket_holder_name_for_owner(uuid, text) is
  'Dono do ingresso altera o nome textual do titular. Nao transfere propriedade.';

-- ============================================================
-- 4. Listagem admin: com/sem titular = holder_full_name
-- ============================================================

create or replace function public.list_admin_tickets(
  p_organization_id uuid,
  p_event_id uuid default null,
  p_situacao text default 'ativos',
  p_ticket_status text default null,
  p_category_id uuid default null,
  p_titularidade text default null,
  p_conta text default null,
  p_checkin text default null,
  p_kit text default null,
  p_pagamento text default null,
  p_search text default null,
  p_user_id uuid default null,
  p_page integer default 1,
  p_page_size integer default 50
) returns table(
  ticket_id uuid,
  token uuid,
  status text,
  issued_at timestamptz,
  used_at timestamptz,
  situacao text,
  event_id uuid,
  event_name text,
  category_name text,
  holder_name text,
  has_holder boolean,
  has_owner boolean,
  order_id uuid,
  order_number text,
  display_number bigint,
  item_position integer,
  payment_status text,
  checkin_done boolean,
  kit_status text,
  wristband_code text,
  total_count bigint
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_situacao text := lower(trim(coalesce(p_situacao, 'ativos')));
  v_status text := lower(trim(coalesce(p_ticket_status, '')));
  v_titularidade text := lower(trim(coalesce(p_titularidade, '')));
  v_conta text := lower(trim(coalesce(p_conta, '')));
  v_checkin text := lower(trim(coalesce(p_checkin, '')));
  v_kit text := lower(trim(coalesce(p_kit, '')));
  v_pagamento text := lower(trim(coalesce(p_pagamento, '')));
  v_search text := lower(trim(coalesce(p_search, '')));
  v_search_digits text := regexp_replace(trim(coalesce(p_search, '')), '[^0-9]', '', 'g');
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := least(100, greatest(1, coalesce(p_page_size, 50)));
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;
  if p_organization_id is null then raise exception 'Organizacao obrigatoria.'; end if;
  if not public.user_can_access_organization(v_actor, p_organization_id) then
    raise exception 'Sem acesso a esta organizacao.';
  end if;
  if not (
    public.current_user_has_permission('participants.view')
    or public.current_user_has_permission('orders.view')
  ) then
    raise exception 'Sem permissao para visualizar ingressos.';
  end if;
  if v_situacao not in ('ativos', 'anteriores', 'cancelados', 'inativos', 'todos') then
    v_situacao := 'ativos';
  end if;
  if v_status not in ('active', 'used', 'cancelled') then
    v_status := '';
  end if;
  if v_pagamento not in ('pago', 'pendente', 'cancelado') then
    v_pagamento := '';
  end if;

  return query
  with kit as (
    select
      pki.ticket_id,
      bool_and(pki.status = 'delivered') as all_delivered,
      count(*) as item_count
    from public.participant_kit_items pki
    where pki.organization_id = p_organization_id
      and pki.ticket_id is not null
      and pki.status <> 'cancelled'
    group by pki.ticket_id
  ),
  wrist as (
    select distinct on (pw.ticket_id)
      pw.ticket_id,
      pw.code
    from public.participant_wristbands pw
    where pw.organization_id = p_organization_id
      and pw.ticket_id is not null
      and pw.status = 'active'
    order by pw.ticket_id, pw.linked_at desc nulls last, pw.id
  ),
  filtered as (
    select
      t.id,
      t.token,
      t.status,
      t.issued_at,
      t.used_at,
      public.ticket_operational_situation(t.status, e.ends_at, e.starts_at, e.is_active, now()) as situacao,
      t.event_id,
      e.name as event_name,
      tc.name as category_name,
      coalesce(nullif(trim(oi.holder_full_name), ''), nullif(trim(p.full_name), ''), 'Sem titular') as holder_name,
      (nullif(trim(oi.holder_full_name), '') is not null) as has_holder,
      (t.owner_user_id is not null) as has_owner,
      t.order_id,
      o.order_number,
      o.display_number,
      oi.item_position,
      public.ticket_admin_payment_class(o.buyer_type, o.import_batch_id, pay.payment_status) as payment_class,
      case public.ticket_admin_payment_class(o.buyer_type, o.import_batch_id, pay.payment_status)
        when 'pago' then 'paid'
        when 'pendente' then coalesce(pay.payment_status, 'pending')
        when 'cancelado' then coalesce(pay.payment_status, 'cancelled')
        else pay.payment_status
      end as payment_status,
      (t.used_at is not null or t.status = 'used') as checkin_done,
      case
        when kit.item_count is null or kit.item_count = 0 then 'none'
        when kit.all_delivered then 'entregue'
        else 'pendente'
      end as kit_status,
      wrist.code as wristband_code,
      p.cpf as holder_cpf,
      p.email as holder_email,
      rc.cpf as contact_cpf,
      rc.email as contact_email,
      rc.full_name as contact_name
    from public.tickets t
    join public.events e on e.id = t.event_id
    left join public.order_items oi on oi.id = t.order_item_id
    left join public.ticket_categories tc on tc.id = oi.ticket_category_id
    left join public.participants p on p.id = coalesce(t.participant_id, oi.participant_id)
    left join public.orders o on o.id = t.order_id
    left join public.payments pay on pay.id = o.payment_id
    left join public.registration_contacts rc on rc.id = oi.registration_contact_id
    left join kit on kit.ticket_id = t.id
    left join wrist on wrist.ticket_id = t.id
    where t.organization_id = p_organization_id
      and (p_event_id is null or t.event_id = p_event_id)
      and (v_status = '' or t.status = v_status)
      and (p_category_id is null or oi.ticket_category_id = p_category_id)
      and (
        v_titularidade = ''
        or (v_titularidade = 'com' and nullif(trim(oi.holder_full_name), '') is not null)
        or (v_titularidade = 'sem' and nullif(trim(oi.holder_full_name), '') is null)
      )
      and (v_conta = '' or (v_conta = 'com' and t.owner_user_id is not null) or (v_conta = 'sem' and t.owner_user_id is null))
      and (
        v_checkin = ''
        or (v_checkin = 'feito' and (t.used_at is not null or t.status = 'used'))
        or (v_checkin = 'pendente' and t.used_at is null and t.status is distinct from 'used')
      )
      and (
        v_kit = ''
        or (v_kit = 'entregue' and kit.item_count > 0 and kit.all_delivered)
        or (v_kit = 'pendente' and kit.item_count > 0 and kit.all_delivered is not true)
      )
      and (
        p_user_id is null
        or p.user_id = p_user_id
      )
  ),
  matched as (
    select f.*
    from filtered f
    where (v_situacao = 'todos' or f.situacao = v_situacao)
      and (v_pagamento = '' or f.payment_class = v_pagamento)
      and (
        v_search = ''
        or f.holder_name ilike '%' || v_search || '%'
        or coalesce(f.contact_name, '') ilike '%' || v_search || '%'
        or coalesce(f.holder_email, '') ilike '%' || v_search || '%'
        or coalesce(f.contact_email, '') ilike '%' || v_search || '%'
        or coalesce(f.order_number, '') ilike '%' || v_search || '%'
        or coalesce(f.wristband_code, '') ilike '%' || v_search || '%'
        or f.token::text ilike '%' || v_search || '%'
        or f.id::text ilike '%' || v_search || '%'
        or (
          v_search_digits <> ''
          and (
            regexp_replace(coalesce(f.holder_cpf, ''), '[^0-9]', '', 'g') like '%' || v_search_digits || '%'
            or regexp_replace(coalesce(f.contact_cpf, ''), '[^0-9]', '', 'g') like '%' || v_search_digits || '%'
            or (f.display_number is not null and f.display_number::text like '%' || v_search_digits || '%')
          )
        )
      )
  )
  select
    m.id,
    m.token,
    m.status,
    m.issued_at,
    m.used_at,
    m.situacao,
    m.event_id,
    m.event_name,
    m.category_name,
    m.holder_name,
    m.has_holder,
    m.has_owner,
    m.order_id,
    m.order_number,
    m.display_number,
    m.item_position,
    m.payment_status,
    m.checkin_done,
    m.kit_status,
    m.wristband_code,
    count(*) over () as total_count
  from matched m
  order by m.issued_at desc nulls last, m.id desc
  offset (v_page - 1) * v_page_size
  limit v_page_size;
end;
$$;

revoke all on function public.list_admin_tickets(uuid, uuid, text, text, uuid, text, text, text, text, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.list_admin_tickets(uuid, uuid, text, text, uuid, text, text, text, text, text, text, uuid, integer, integer) to authenticated, service_role;

-- ============================================================
-- 5. Checkout nome-so: titular valido, sem Cadastro
--    CPF/e-mail/telefone continuam no caminho legado de identidade (nao ampliado).
-- ============================================================

create or replace function public.materialize_named_checkout_holders(p_order_id uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_ticket public.tickets%rowtype; v_contact public.registration_contacts%rowtype;
  v_participant public.participants%rowtype; v_payload jsonb; v_index integer;
  v_mode text; v_name text; v_cpf text; v_email text; v_phone text; v_contact_id uuid;
  v_contact_count integer; v_participant_count integer; v_has_reliable_identity boolean;
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  select * into v_order from public.orders where id = p_order_id and user_id = v_actor for update;
  if not found then raise exception 'Pedido do checkout nao encontrado.'; end if;

  for v_index in 1..jsonb_array_length(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) loop
    v_payload := p_items -> (v_index - 1); v_mode := lower(trim(coalesce(v_payload->>'ownership_mode', '')));
    if v_mode <> 'named' then continue; end if;
    select * into v_item from public.order_items where order_id = v_order.id and item_position = v_index for update;
    if not found then raise exception 'Item nomeado do checkout nao encontrado na posicao %.', v_index; end if;
    if v_item.registration_contact_id is not null and v_item.participant_id is not null then continue; end if;

    v_name := nullif(trim(coalesce(v_payload->>'holder_full_name', '')), '');
    v_contact := null;
    v_participant := null;
    v_cpf := nullif(regexp_replace(coalesce(v_payload->>'holder_cpf', ''), '\D', '', 'g'), '');
    v_email := lower(nullif(trim(coalesce(v_payload->>'holder_email', '')), ''));
    v_phone := nullif(regexp_replace(coalesce(v_payload->>'holder_phone', ''), '\D', '', 'g'), '');
    v_contact_id := nullif(trim(coalesce(v_payload->>'holder_registration_contact_id', '')), '')::uuid;
    v_has_reliable_identity := v_name is not null and (
      v_contact_id is not null or public.is_valid_cpf(v_cpf)
      or (v_email is not null and v_email like '%_@_%._%' and length(v_phone) >= 10)
    );

    select * into v_ticket from public.tickets where order_item_id = v_item.id for update;
    if not found then v_ticket.id := null; v_ticket.owner_user_id := null; end if;

    if not v_has_reliable_identity then
      -- Nome livre e titular valido. Nao cria Cadastro, participant nem pendencia.
      update public.order_items
      set
        participant_id = null,
        registration_contact_id = null,
        holder_full_name = v_name,
        ownership_status = case when v_name is null then 'unassigned' else 'assigned' end,
        updated_at = now()
      where id = v_item.id;
      if v_ticket.id is not null then
        update public.tickets set participant_id = null where id = v_ticket.id;
      end if;
      update public.participant_data_issues
      set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
      where order_item_id = v_item.id and status = 'open' and issue_type = 'insufficient_named_holder_identity';
      insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
      values (
        'named_ticket_holder_textual',
        case when v_ticket.id is null then 'order_items' else 'tickets' end,
        coalesce(v_ticket.id, v_item.id),
        v_item.event_id,
        jsonb_build_object(
          'actor_user_id', v_actor, 'order_id', v_order.id, 'order_item_id', v_item.id,
          'ticket_id', v_ticket.id, 'owner_user_id', v_ticket.owner_user_id,
          'holder_full_name_snapshot', v_name
        )
      );
      continue;
    end if;

    if v_contact_id is not null then
      select * into v_contact from public.registration_contacts where id = v_contact_id and organization_id = v_order.organization_id for update;
      if not found then raise exception 'Cadastro indicado para titular nao pertence a organizacao.'; end if;
      if public.is_valid_cpf(v_cpf) and public.is_valid_cpf(v_contact.cpf)
        and regexp_replace(v_contact.cpf, '\D', '', 'g') <> v_cpf then raise exception 'CPF do titular diverge do cadastro indicado.'; end if;
    elsif public.is_valid_cpf(v_cpf) then
      select count(*), (array_agg(rc.id order by rc.id))[1] into v_contact_count, v_contact_id
      from public.registration_contacts rc where rc.organization_id = v_order.organization_id
        and regexp_replace(coalesce(rc.cpf, ''), '\D', '', 'g') = v_cpf;
      if v_contact_count > 1 then raise exception 'Conflito de identidade: CPF do titular possui mais de um cadastro.'; end if;
      if v_contact_count = 1 then select * into v_contact from public.registration_contacts where id = v_contact_id for update; end if;
    end if;

    -- Caminho legado: CPF/e-mail+telefone ainda materializam identidade. Nao ampliado.
    if v_contact.id is null then
      insert into public.registration_contacts(organization_id, full_name, cpf, phone, email, created_by)
      values (v_order.organization_id, v_name, case when public.is_valid_cpf(v_cpf) then v_cpf end, v_phone, v_email, v_actor)
      returning * into v_contact;
    else
      update public.registration_contacts set
        phone = coalesce(phone, v_phone), email = coalesce(email, v_email), updated_at = now()
      where id = v_contact.id returning * into v_contact;
    end if;

    select count(*), (array_agg(p.id order by p.id))[1] into v_participant_count, v_participant.id
    from public.participants p where p.event_id = v_item.event_id and p.registration_contact_id = v_contact.id;
    if v_participant_count > 1 then raise exception 'Conflito de titularidade: cadastro possui mais de uma projecao no evento.'; end if;
    if v_participant_count = 1 then
      select * into v_participant from public.participants where id = v_participant.id for update;
    else
      insert into public.participants(event_id, organization_id, registration_contact_id, user_id, full_name, cpf, birth_date, gender, phone, email, city,
        registration_status, reservation_status, notes)
      values (v_item.event_id, v_order.organization_id, v_contact.id, null, v_contact.full_name, v_contact.cpf, v_contact.birth_date,
        v_contact.gender, v_contact.phone, v_contact.email, v_contact.city,
        case when v_item.status = 'confirmed' then 'confirmed' else 'pending' end,
        case when v_item.status = 'confirmed' then 'confirmed' else 'pending' end, 'LEGACY projection of named checkout holder')
      returning * into v_participant;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_item.event_id::text || ':' || v_contact.id::text, 0));
    if exists (
      select 1 from public.order_items oi left join public.participants op on op.id = oi.participant_id
      where oi.event_id = v_item.event_id and oi.id <> v_item.id
        and coalesce(oi.registration_contact_id, op.registration_contact_id) = v_contact.id
        and oi.status not in ('cancelled', 'expired', 'refunded')
    ) then
      raise exception using errcode = 'P0001', message = 'HOLDER_ALREADY_HAS_TICKET_FOR_EVENT',
        detail = jsonb_build_object('code', 'HOLDER_ALREADY_HAS_TICKET_FOR_EVENT', 'message', 'Esta pessoa ja e titular de outro ingresso neste evento.')::text;
    end if;

    update public.order_items set
      participant_id = v_participant.id,
      registration_contact_id = v_contact.id,
      holder_full_name = coalesce(v_name, v_contact.full_name),
      ownership_status = 'assigned',
      updated_at = now()
    where id = v_item.id;
    if v_ticket.id is not null then update public.tickets set participant_id = v_participant.id where id = v_ticket.id; end if;
    update public.participant_kit_items set participant_id = v_participant.id where order_item_id = v_item.id;
    update public.participant_data_issues set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
      where order_item_id = v_item.id and status = 'open' and issue_type = 'insufficient_named_holder_identity';
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'named_ticket_holder_materialized',
      case when v_ticket.id is null then 'order_items' else 'tickets' end,
      coalesce(v_ticket.id, v_item.id), v_item.event_id,
      jsonb_build_object(
        'actor_user_id', v_actor, 'order_id', v_order.id, 'order_item_id', v_item.id,
        'ticket_id', v_ticket.id, 'participant_id', v_participant.id,
        'registration_contact_id', v_contact.id, 'owner_user_id', v_ticket.owner_user_id,
        'holder_full_name_snapshot', v_name
      )
    );
  end loop;
end;
$$;

-- ============================================================
-- 6. Integridade: nome textual nao e mais "titular incompleto"
-- ============================================================

create or replace function public.detect_integrity_named_without_holder(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    'TICKET_NAMED_WITHOUT_CANONICAL_HOLDER'::text,
    'attention'::text,
    'titularidade'::text,
    'Titular incompleto'::text,
    'O ingresso possui um nome informado, mas ainda não está corretamente vinculado a uma pessoa.'::text,
    null::uuid,
    'order_item'::text,
    null::uuid,
    'Definir titular'::text,
    '/ingressos'::text,
    '{}'::jsonb
  where false;
$$;

revoke all on function public.detect_integrity_named_without_holder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_named_without_holder(uuid, uuid) to service_role;

create or replace function public.get_operational_integrity_detector_codes()
returns table(code text, domain text, label text)
language sql
immutable
as $$
  select * from (values
    ('TICKET_NAMED_WITHOUT_CANONICAL_HOLDER', 'titularidade', 'Nome textual do titular é válido; detector legado inativo'),
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

commit;
