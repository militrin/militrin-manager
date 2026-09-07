-- Listagem administrativa de ingressos com filtros combinaveis no backend.
-- Nao altera dados: leitura pura. Nao cria status novo de ticket.
--
-- tickets.status reais: active | used | cancelled
-- "Inativo" na UI = evento desativado (events.is_active = false) com ingresso
-- ainda nao cancelado e evento ainda nao encerrado. Ver ticket_operational_situation.

begin;

create or replace function public.ticket_operational_situation(
  p_ticket_status text,
  p_event_ends_at timestamptz,
  p_event_starts_at timestamptz,
  p_event_is_active boolean,
  p_now timestamptz default now()
) returns text
language sql
immutable
as $$
  select case
    when lower(trim(coalesce(p_ticket_status, ''))) in ('cancelled', 'canceled') then 'cancelados'
    when coalesce(p_event_ends_at, p_event_starts_at) is not null
      and coalesce(p_event_ends_at, p_event_starts_at) <= p_now then 'anteriores'
    when coalesce(p_event_is_active, false) = false then 'inativos'
    else 'ativos'
  end;
$$;

revoke all on function public.ticket_operational_situation(text, timestamptz, timestamptz, boolean, timestamptz) from public, anon;
grant execute on function public.ticket_operational_situation(text, timestamptz, timestamptz, boolean, timestamptz) to authenticated, service_role;

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
      coalesce(nullif(trim(p.full_name), ''), nullif(trim(oi.holder_full_name), ''), 'Sem titular') as holder_name,
      (t.participant_id is not null) as has_holder,
      (t.owner_user_id is not null) as has_owner,
      t.order_id,
      o.order_number,
      o.display_number,
      oi.item_position,
      pay.payment_status,
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
    left join public.participants p on p.id = t.participant_id
    left join public.orders o on o.id = t.order_id
    left join public.payments pay on pay.id = o.payment_id
    left join public.registration_contacts rc on rc.id = oi.registration_contact_id
    left join kit on kit.ticket_id = t.id
    left join wrist on wrist.ticket_id = t.id
    where t.organization_id = p_organization_id
      and (p_event_id is null or t.event_id = p_event_id)
      and (v_status = '' or t.status = v_status)
      and (p_category_id is null or oi.ticket_category_id = p_category_id)
      and (v_titularidade = '' or (v_titularidade = 'com' and t.participant_id is not null) or (v_titularidade = 'sem' and t.participant_id is null))
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
        v_pagamento = ''
        or (v_pagamento = 'pago' and pay.payment_status = 'paid')
        or (v_pagamento = 'pendente' and pay.payment_status = 'pending')
        or (v_pagamento = 'cancelado' and pay.payment_status in ('cancelled', 'refunded', 'expired'))
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

commit;
