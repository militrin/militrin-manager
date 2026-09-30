-- Central de Operacoes: filtros/busca/count/order/paginacao no universo
-- completo do evento. SOMENTE LEITURA. Nao altera tickets, pagamentos,
-- kit, pulseira nem titularidade.
--
-- Indice novo: nenhum neste lote; medir no evento atual antes de CREATE INDEX.

begin;

create or replace function public.operation_fold_text(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(translate(
    coalesce(p_value, ''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'
  ));
$$;

create or replace function public.operation_pad_display_number(p_value bigint)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_value is null or p_value <= 0 then null
    when length(p_value::text) >= 6 then p_value::text
    else lpad(p_value::text, 6, '0')
  end;
$$;

create or replace function public.operation_ticket_display_code(
  p_display_number bigint,
  p_item_position integer,
  p_order_number text
)
returns text
language sql
immutable
parallel safe
as $$
  select
    case
      when public.operation_pad_display_number(p_display_number) is not null
           and p_item_position is not null
           and p_item_position > 0
        then '#'
          || public.operation_pad_display_number(p_display_number)
          || '-'
          || case
               when length(p_item_position::text) >= 2 then p_item_position::text
               else lpad(p_item_position::text, 2, '0')
             end
      when public.operation_pad_display_number(p_display_number) is not null
        then '#' || public.operation_pad_display_number(p_display_number)
      when coalesce(p_order_number, '') ~* '^MIL-[0-9]{4}-[0-9]+$'
           and (substring(p_order_number from 'MIL-[0-9]{4}-([0-9]+)$'))::bigint > 0
           and p_item_position is not null
           and p_item_position > 0
        then '#'
          || public.operation_pad_display_number((substring(p_order_number from 'MIL-[0-9]{4}-([0-9]+)$'))::bigint)
          || '-'
          || case
               when length(p_item_position::text) >= 2 then p_item_position::text
               else lpad(p_item_position::text, 2, '0')
             end
      else null
    end;
$$;

create or replace function public.operation_payment_kind(
  p_payment_status text,
  p_payment_method text,
  p_price_origin text,
  p_ticket_status text
)
returns text
language sql
immutable
parallel safe
as $$
  select
    case
      when lower(trim(coalesce(p_ticket_status, ''))) in ('cancelled', 'canceled')
        or lower(trim(coalesce(p_payment_status, ''))) in ('cancelled', 'canceled')
        then 'cancelled'
      when lower(trim(coalesce(p_payment_status, ''))) = 'refunded' then 'refunded'
      when lower(trim(coalesce(p_payment_method, ''))) in ('courtesy', 'admin_courtesy')
           and lower(trim(coalesce(p_payment_status, ''))) in ('paid', 'confirmed', '')
        then 'courtesy'
      when lower(trim(coalesce(p_price_origin, ''))) in ('legacy_unknown', 'legacy_provided')
           and lower(trim(coalesce(p_payment_status, ''))) in ('paid', 'confirmed', 'pending', '', 'processing')
        then 'legacy_paid'
      when lower(trim(coalesce(p_payment_status, ''))) in ('paid', 'confirmed') then 'paid'
      else 'pending'
    end;
$$;

create or replace function public.list_operation_ticket_page(
  p_event_id uuid,
  p_search text default null,
  p_category text default null,
  p_city text default null,
  p_gender text default null,
  p_age_group text default null,
  p_payment_status text default null,
  p_kit_status text default null,
  p_checkin_status text default null,
  p_wristband_status text default null,
  p_shirt_type text default null,
  p_shirt_size text default null,
  p_only_pending boolean default false,
  p_sort_field text default 'name',
  p_sort_direction text default 'asc',
  p_offset integer default 0,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_organization_id uuid;
  v_kit_enabled boolean := false;
  v_wristband_enabled boolean := false;
  v_kit_count integer := 0;
  v_event_has_kit boolean := false;
  v_search text := lower(trim(coalesce(p_search, '')));
  v_search_compact text := regexp_replace(trim(coalesce(p_search, '')), '\s+', '', 'g');
  v_search_fold text := public.operation_fold_text(trim(coalesce(p_search, '')));
  v_search_digits text := regexp_replace(trim(coalesce(p_search, '')), '\D', '', 'g');
  v_exact_code text[] := regexp_match(v_search_compact, '^#?0*([1-9][0-9]{0,17})-0*([1-9][0-9]{0,8})$');
  v_wanted_code text := null;
  v_category text := nullif(trim(coalesce(p_category, '')), '');
  v_city text := nullif(trim(coalesce(p_city, '')), '');
  v_gender text := nullif(trim(coalesce(p_gender, '')), '');
  v_age_group text := nullif(trim(coalesce(p_age_group, '')), '');
  v_payment_status text := nullif(trim(coalesce(p_payment_status, '')), '');
  v_kit_status text := nullif(trim(coalesce(p_kit_status, '')), '');
  v_checkin_status text := nullif(trim(coalesce(p_checkin_status, '')), '');
  v_wristband_status text := nullif(trim(coalesce(p_wristband_status, '')), '');
  v_shirt_type text := nullif(trim(coalesce(p_shirt_type, '')), '');
  v_shirt_size text := nullif(trim(coalesce(p_shirt_size, '')), '');
  v_sort_field text := lower(trim(coalesce(p_sort_field, 'name')));
  v_sort_direction text := lower(trim(coalesce(p_sort_direction, 'asc')));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_limit integer := least(100, greatest(0, coalesce(p_limit, 50)));
  v_operational_total integer := 0;
  v_filtered_count integer := 0;
  v_ticket_ids jsonb := '[]'::jsonb;
  v_facets jsonb;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;
  if not public.current_user_has_permission('participants.view') then
    raise exception 'Sem permissao para visualizar ingressos.';
  end if;

  select e.organization_id, coalesce(e.kit_enabled, false), coalesce(e.wristband_enabled, false)
    into v_organization_id, v_kit_enabled, v_wristband_enabled
  from public.events e
  where e.id = p_event_id;

  if v_organization_id is null then
    raise exception 'Evento nao encontrado.';
  end if;
  if not public.user_can_access_organization(v_actor, v_organization_id) then
    raise exception 'Sem acesso a esta organizacao.';
  end if;

  if v_category in ('all', '*') then v_category := null; end if;
  if v_city in ('all', '*') then v_city := null; end if;
  if v_gender in ('all', '*') then v_gender := null; end if;
  if v_age_group in ('all', '*') then v_age_group := null; end if;
  if v_payment_status in ('all', '*') then v_payment_status := null; end if;
  if v_kit_status in ('all', '*') then v_kit_status := null; end if;
  if v_checkin_status in ('all', '*') then v_checkin_status := null; end if;
  if v_wristband_status in ('all', '*') then v_wristband_status := null; end if;
  if v_shirt_type in ('all', '*') then v_shirt_type := null; end if;
  if v_shirt_size in ('all', '*') then v_shirt_size := null; end if;
  if v_sort_field not in ('name', 'city', 'gender', 'age', 'shirt_type', 'shirt_size', 'payment', 'kit', 'checkin', 'wristband') then
    v_sort_field := 'name';
  end if;
  if v_sort_direction not in ('asc', 'desc') then
    v_sort_direction := 'asc';
  end if;

  if v_exact_code is not null then
    v_wanted_code := '#'
      || public.operation_pad_display_number(v_exact_code[1]::bigint)
      || '-'
      || case
           when length(v_exact_code[2]) >= 2 then v_exact_code[2]
           else lpad(v_exact_code[2], 2, '0')
         end;
  end if;

  select count(*) into v_kit_count
  from public.event_kit_items eki
  where eki.event_id = p_event_id
    and eki.is_active = true;

  v_event_has_kit := v_kit_enabled or v_kit_count > 0;

  select count(*) into v_operational_total
  from public.tickets t
  where t.event_id = p_event_id
    and t.status in ('active', 'used');

  with event_kit as (
    select eki.id
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.is_active = true
  ),
  kit_stats as (
    select
      pki.ticket_id,
      count(*)::integer as linked_count,
      count(*) filter (where pki.status = 'delivered')::integer as delivered_count
    from public.participant_kit_items pki
    where pki.ticket_id is not null
      and pki.kit_item_id in (select id from event_kit)
    group by pki.ticket_id
  ),
  chosen_pay as (
    select distinct on (pay.order_id)
      pay.order_id,
      pay.payment_status,
      pay.payment_method,
      pay.price_origin
    from public.payments pay
    where pay.order_id in (
      select t.order_id
      from public.tickets t
      where t.event_id = p_event_id
        and t.order_id is not null
    )
    order by
      pay.order_id,
      case
        when lower(coalesce(pay.payment_status, '')) in ('paid', 'confirmed', 'succeeded') then 0
        when lower(coalesce(pay.payment_status, '')) = 'pending' then 1
        when lower(coalesce(pay.payment_status, '')) = 'processing' then 2
        else 3
      end,
      coalesce(pay.paid_at, pay.created_at) desc nulls last
  ),
  wrist as (
    select distinct on (pw.ticket_id)
      pw.ticket_id,
      pw.code,
      pw.status
    from public.participant_wristbands pw
    where pw.ticket_id in (
      select t.id from public.tickets t where t.event_id = p_event_id
    )
      and pw.status = 'active'
    order by pw.ticket_id, pw.linked_at desc nulls last, pw.id
  ),
  universe as (
    select
      t.id,
      t.status as ticket_status,
      t.token::text as ticket_token,
      public.operation_ticket_display_code(o.display_number, oi.item_position, o.order_number) as ticket_display_code,
      o.order_number,
      coalesce(nullif(trim(cp.full_name), ''), '') as buyer_name,
      coalesce(nullif(trim(cp.cpf), ''), '') as buyer_cpf,
      coalesce(nullif(trim(cp.phone), ''), '') as buyer_phone,
      coalesce(nullif(trim(au.email::text), ''), '') as buyer_email,
      coalesce(
        nullif(trim(oi.holder_full_name), ''),
        nullif(trim(op.full_name), ''),
        nullif(trim(p.full_name), ''),
        ''
      ) as holder_name,
      coalesce(nullif(trim(p.email), ''), nullif(trim(op.email), ''), '') as holder_email,
      coalesce(nullif(trim(p.cpf), ''), nullif(trim(op.cpf), ''), nullif(trim(rc_item.cpf), ''), '') as holder_cpf,
      coalesce(nullif(trim(p.phone), ''), nullif(trim(op.phone), ''), nullif(trim(rc_item.phone), ''), '') as holder_phone,
      coalesce(nullif(trim(p.city), ''), nullif(trim(op.city), ''), '') as city,
      coalesce(nullif(trim(p.gender), ''), nullif(trim(op.gender), ''), '') as gender,
      coalesce(p.birth_date, op.birth_date) as birth_date,
      coalesce(nullif(trim(oi.shirt_type), ''), nullif(trim(p.shirt_type), ''), '') as shirt_type,
      coalesce(nullif(trim(oi.shirt_size), ''), nullif(trim(p.shirt_size), ''), '') as shirt_size,
      coalesce(nullif(trim(tc.name), ''), nullif(trim(ptc.name), ''), 'Ingresso único') as category_name,
      coalesce(pay.payment_status, 'pending') as payment_status,
      public.operation_payment_kind(
        coalesce(pay.payment_status, 'pending'),
        pay.payment_method,
        pay.price_origin,
        t.status
      ) as payment_kind,
      case
        when t.status = 'used' or t.used_at is not null then 'done'
        else 'pending'
      end as checkin_status,
      case
        when v_kit_count = 0 then 'none'
        when coalesce(ks.linked_count, 0) < v_kit_count then 'configuration_pending'
        when coalesce(ks.delivered_count, 0) = 0 then 'pending'
        when ks.delivered_count = ks.linked_count then 'delivered'
        else 'partial'
      end as kit_status,
      coalesce(w.status, 'none') as wristband_status,
      coalesce(w.code, '') as wristband_code
    from public.tickets t
    left join public.order_items oi on oi.id = t.order_item_id
    left join public.orders o on o.id = t.order_id
    left join public.ticket_categories tc on tc.id = oi.ticket_category_id
    left join public.participants p on p.id = t.participant_id
    left join public.participants op on op.id = oi.participant_id
    left join public.ticket_categories ptc on ptc.id = p.ticket_category_id
    left join public.registration_contacts rc_item on rc_item.id = oi.registration_contact_id
    left join public.customer_profiles cp on cp.user_id = o.user_id
    left join auth.users au on au.id = o.user_id
    left join chosen_pay pay on pay.order_id = t.order_id
    left join kit_stats ks on ks.ticket_id = t.id
    left join wrist w on w.ticket_id = t.id
    where t.event_id = p_event_id
      and t.status in ('active', 'used')
  ),
  matched as (
    select
      u.*,
      case
        when u.birth_date is null then null
        else (extract(year from age(current_date, u.birth_date::date)))::integer
      end as age_years,
      case lower(u.shirt_type)
        when 'camiseta' then 0
        when 'babylook' then 1
        else 99
      end as shirt_type_rank,
      case upper(u.shirt_size)
        when 'PP' then 0
        when 'P' then 1
        when 'M' then 2
        when 'G' then 3
        when 'GG' then 4
        when 'EG' then 5
        when 'EXG' then 6
        when 'EXGG' then 7
        else 99
      end as shirt_size_rank,
      case u.payment_status
        when 'paid' then 0
        when 'pending' then 1
        else 2
      end as payment_rank,
      case u.kit_status
        when 'pending' then 0
        when 'partial' then 1
        when 'configuration_pending' then 2
        when 'delivered' then 3
        when 'none' then 4
        else 5
      end as kit_rank,
      case when u.checkin_status = 'pending' then 0 else 1 end as checkin_rank,
      case when u.wristband_status = 'active' then 0 else 1 end as wristband_rank
    from universe u
    where (
        v_wanted_code is null
        or u.ticket_display_code = v_wanted_code
      )
      and (
        v_wanted_code is not null
        or v_search_fold = ''
        or public.operation_fold_text(concat_ws(' ',
          u.holder_name,
          u.holder_email,
          u.holder_cpf,
          u.holder_phone,
          u.buyer_name,
          u.buyer_cpf,
          u.buyer_phone,
          u.buyer_email,
          u.ticket_token,
          u.wristband_code,
          u.order_number,
          u.ticket_display_code
        )) like '%' || v_search_fold || '%'
        or (
          length(v_search_digits) >= 3
          and regexp_replace(concat_ws(' ', u.holder_cpf, u.holder_phone, u.buyer_cpf, u.buyer_phone), '\D', '', 'g')
            like '%' || v_search_digits || '%'
        )
      )
      and (v_category is null or u.category_name = v_category)
      and (v_city is null or u.city = v_city)
      and (
        v_gender is null
        or (v_gender = 'not_informed' and coalesce(u.gender, '') = '')
        or (v_gender not in ('not_informed') and u.gender = v_gender)
      )
      and (v_payment_status is null or u.payment_status = v_payment_status)
      and (v_kit_status is null or u.kit_status = v_kit_status)
      and (v_checkin_status is null or u.checkin_status = v_checkin_status)
      and (
        v_wristband_status is null
        or (v_wristband_status = 'active' and u.wristband_status = 'active')
        or (v_wristband_status = 'pending' and u.wristband_status is distinct from 'active')
      )
      and (v_shirt_type is null or u.shirt_type = v_shirt_type)
      and (v_shirt_size is null or u.shirt_size = v_shirt_size)
      and (
        not coalesce(p_only_pending, false)
        or u.payment_kind = 'pending'
        or u.checkin_status is distinct from 'done'
        or (v_event_has_kit and u.kit_status not in ('delivered', 'none'))
        or (v_wristband_enabled and u.wristband_status is distinct from 'active')
      )
  ),
  age_filtered as (
    select m.*
    from matched m
    where v_age_group is null
      or (
        m.age_years is not null
        and (
          (v_age_group = 'lt18' and m.age_years < 18)
          or (v_age_group = '18to29' and m.age_years between 18 and 29)
          or (v_age_group = '30to39' and m.age_years between 30 and 39)
          or (v_age_group = '40to49' and m.age_years between 40 and 49)
          or (v_age_group = '50plus' and m.age_years >= 50)
        )
      )
  ),
  ordered as (
    select
      a.id,
      case v_sort_field
        when 'city' then public.operation_fold_text(a.city)
        when 'gender' then public.operation_fold_text(a.gender)
        when 'age' then lpad(coalesce(a.age_years, 2147483647)::text, 10, '0')
        when 'shirt_type' then lpad(a.shirt_type_rank::text, 4, '0') || public.operation_fold_text(a.shirt_type)
        when 'shirt_size' then lpad(a.shirt_size_rank::text, 4, '0') || public.operation_fold_text(a.shirt_size)
        when 'payment' then lpad(a.payment_rank::text, 4, '0') || public.operation_fold_text(a.payment_status)
        when 'kit' then lpad(a.kit_rank::text, 4, '0') || public.operation_fold_text(a.kit_status)
        when 'checkin' then lpad(a.checkin_rank::text, 4, '0')
        when 'wristband' then lpad(a.wristband_rank::text, 4, '0') || public.operation_fold_text(a.wristband_code)
        else public.operation_fold_text(coalesce(nullif(a.buyer_name, ''), a.holder_name))
      end as sort_key
    from age_filtered a
  )
  select
    (select count(*) from ordered),
    coalesce(
      (
        select jsonb_agg(page_rows.id order by page_rows.ord)
        from (
          select
            ranked.id,
            ranked.ord
          from (
            select
              o.id,
              row_number() over (
                order by
                  case when v_sort_direction = 'desc' then o.sort_key end desc,
                  case when v_sort_direction = 'asc' then o.sort_key end asc,
                  o.id
              ) as ord
            from ordered o
          ) ranked
          where v_limit > 0
            and ranked.ord > v_offset
            and ranked.ord <= v_offset + v_limit
        ) page_rows
      ),
      '[]'::jsonb
    )
  into v_filtered_count, v_ticket_ids;

  select jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(val order by val)
      from (
        select distinct coalesce(nullif(trim(tc.name), ''), nullif(trim(ptc.name), ''), 'Ingresso único') as val
        from public.tickets t
        left join public.order_items oi on oi.id = t.order_item_id
        left join public.ticket_categories tc on tc.id = oi.ticket_category_id
        left join public.participants p on p.id = t.participant_id
        left join public.ticket_categories ptc on ptc.id = p.ticket_category_id
        where t.event_id = p_event_id
          and t.status in ('active', 'used')
      ) s
      where val is not null and val <> ''
    ), '[]'::jsonb),
    'cities', coalesce((
      select jsonb_agg(val order by val)
      from (
        select distinct coalesce(nullif(trim(p.city), ''), nullif(trim(op.city), '')) as val
        from public.tickets t
        left join public.order_items oi on oi.id = t.order_item_id
        left join public.participants p on p.id = t.participant_id
        left join public.participants op on op.id = oi.participant_id
        where t.event_id = p_event_id
          and t.status in ('active', 'used')
      ) s
      where val is not null and val <> ''
    ), '[]'::jsonb),
    'shirt_types', coalesce((
      select jsonb_agg(val order by val)
      from (
        select distinct coalesce(nullif(trim(oi.shirt_type), ''), nullif(trim(p.shirt_type), '')) as val
        from public.tickets t
        left join public.order_items oi on oi.id = t.order_item_id
        left join public.participants p on p.id = t.participant_id
        where t.event_id = p_event_id
          and t.status in ('active', 'used')
      ) s
      where val is not null and val <> ''
    ), '[]'::jsonb),
    'shirt_sizes', coalesce((
      select jsonb_agg(val order by val)
      from (
        select distinct coalesce(nullif(trim(oi.shirt_size), ''), nullif(trim(p.shirt_size), '')) as val
        from public.tickets t
        left join public.order_items oi on oi.id = t.order_item_id
        left join public.participants p on p.id = t.participant_id
        where t.event_id = p_event_id
          and t.status in ('active', 'used')
      ) s
      where val is not null and val <> ''
    ), '[]'::jsonb)
  )
  into v_facets;

  return jsonb_build_object(
    'ticket_ids', coalesce(v_ticket_ids, '[]'::jsonb),
    'filtered_count', coalesce(v_filtered_count, 0),
    'operational_total', coalesce(v_operational_total, 0),
    'page_offset', v_offset,
    'page_limit', v_limit,
    'facets', coalesce(v_facets, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.operation_fold_text(text) from public, anon;
grant execute on function public.operation_fold_text(text) to authenticated, service_role;

revoke all on function public.operation_pad_display_number(bigint) from public, anon;
grant execute on function public.operation_pad_display_number(bigint) to authenticated, service_role;

revoke all on function public.operation_ticket_display_code(bigint, integer, text) from public, anon;
grant execute on function public.operation_ticket_display_code(bigint, integer, text) to authenticated, service_role;

revoke all on function public.operation_payment_kind(text, text, text, text) from public, anon;
grant execute on function public.operation_payment_kind(text, text, text, text) to authenticated, service_role;

revoke all on function public.list_operation_ticket_page(
  uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text, integer, integer
) from public, anon;
grant execute on function public.list_operation_ticket_page(
  uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text, integer, integer
) to authenticated, service_role;

commit;
