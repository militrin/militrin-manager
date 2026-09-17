-- Código do ingresso = orders.display_number + order_items.item_position.
-- Não cria identificador novo. Completa item_position só quando o pedido
-- tem exatamente um ingresso ticket e a posição está nula.
-- Depois de definidos, display_number e item_position são imutáveis.

begin;

do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from (
    select oi.order_id
    from public.order_items oi
    where coalesce(oi.item_kind, 'ticket') = 'ticket'
    group by oi.order_id
    having count(*) > 1 and count(*) filter (where oi.item_position is null) > 0
  ) x;
  if v_bad > 0 then
    raise exception 'TICKET_DISPLAY_CODE_BACKFILL_BLOCKED: % pedidos com mais de um ingresso e item_position nulo', v_bad;
  end if;
end $$;

update public.order_items oi
set item_position = 1
where oi.item_position is null
  and coalesce(oi.item_kind, 'ticket') = 'ticket'
  and not exists (
    select 1
    from public.order_items other
    where other.order_id = oi.order_id
      and other.id <> oi.id
      and coalesce(other.item_kind, 'ticket') = 'ticket'
  );

create or replace function public.assign_ticket_item_position()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if coalesce(new.item_kind, 'ticket') is distinct from 'ticket' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.item_position is not null and new.item_position is distinct from old.item_position then
      raise exception 'TICKET_ITEM_POSITION_IMMUTABLE: item_position do ingresso nao pode ser alterado';
    end if;
    if new.item_position is null then
      raise exception 'TICKET_ITEM_POSITION_REQUIRED: ingresso nao pode ficar sem item_position';
    end if;
    return new;
  end if;
  if new.item_position is not null then
    return new;
  end if;
  select coalesce(max(oi.item_position), 0) + 1
    into new.item_position
    from public.order_items oi
    where oi.order_id = new.order_id
      and coalesce(oi.item_kind, 'ticket') = 'ticket';
  return new;
end;
$$;

drop trigger if exists trg_assign_ticket_item_position on public.order_items;
create trigger trg_assign_ticket_item_position
before insert or update on public.order_items
for each row execute function public.assign_ticket_item_position();

create or replace function public.protect_order_display_number()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if old.display_number is distinct from new.display_number then
    raise exception 'ORDER_DISPLAY_NUMBER_IMMUTABLE: display_number do pedido nao pode ser alterado';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_order_display_number on public.orders;
create trigger trg_protect_order_display_number
before update on public.orders
for each row execute function public.protect_order_display_number();

comment on function public.protect_order_display_number() is
  'Impede UPDATE de orders.display_number depois que o numero publico foi definido.';
comment on function public.assign_ticket_item_position() is
  'Atribui item_position no INSERT e impede alteracao posterior, inclusive para null.';

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
  v_code_parts text[] := regexp_match(regexp_replace(trim(coalesce(p_search, '')), '\s+', '', 'g'), '^#?0*([1-9][0-9]{0,17})-0*([1-9][0-9]{0,8})$');
  v_code_display bigint := null;
  v_code_position integer := null;
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
  if v_code_parts is not null then
    v_code_display := v_code_parts[1]::bigint;
    v_code_position := v_code_parts[2]::integer;
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
        (
          v_code_display is not null
          and f.display_number = v_code_display
          and f.item_position = v_code_position
        )
        or (
          v_code_display is null
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

commit;
