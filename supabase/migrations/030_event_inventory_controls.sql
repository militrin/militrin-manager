-- 029_event_inventory_controls.sql
-- Controles administrativos de estoque por evento + sincronizacao checkout/estoque.

alter table if exists public.events
  add column if not exists limit_shirt_selection_to_stock boolean not null default false;

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('inventory.limit_selection', 'Limitar escolha por estoque', 'Controla se o checkout deve limitar escolha de tamanhos pelo saldo fisico.', 'inventory', 45, true),
  ('inventory.reset', 'Zerar estoque', 'Permite zerar quantidades operacionais de estoque por evento.', 'inventory', 55, true),
  ('inventory.clear_history', 'Limpar historico de estoque', 'Permite zeragem completa com remocao do historico de movimentacoes.', 'inventory', 56, true)
on conflict (code) do update
set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

with role_permissions(role_name, permission_code) as (
  values
    ('Owner', 'inventory.limit_selection'),
    ('Owner', 'inventory.reset'),
    ('Owner', 'inventory.clear_history'),
    ('Administrator', 'inventory.limit_selection'),
    ('Administrator', 'inventory.reset'),
    ('Administrator', 'inventory.clear_history'),
    ('Administrador', 'inventory.limit_selection'),
    ('Administrador', 'inventory.reset'),
    ('Administrador', 'inventory.clear_history'),
    ('Inventory', 'inventory.limit_selection'),
    ('Inventory', 'inventory.reset'),
    ('Estoque', 'inventory.limit_selection'),
    ('Estoque', 'inventory.reset')
)
insert into public.admin_role_permissions (role_id, permission_id)
select distinct r.id, p.id
from role_permissions rp
join public.admin_roles r
  on lower(r.name) = lower(rp.role_name)
join public.admin_permissions p
  on p.code = rp.permission_code
on conflict do nothing;

create or replace function public.set_event_shirt_stock_limit(
  p_event_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
  v_actor text := coalesce((select email from auth.users where id = auth.uid()), auth.role(), 'system');
begin
  if not public.current_user_has_permission('inventory.limit_selection'::text) then
    raise exception 'Sem permissao para alterar limitacao de estoque.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  update public.events
  set
    limit_shirt_selection_to_stock = coalesce(p_enabled, false),
    updated_at = now()
  where id = p_event_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_limit_selection_updated',
    'events',
    p_event_id,
    p_event_id,
    jsonb_build_object(
      'before', coalesce(v_event.limit_shirt_selection_to_stock, false),
      'after', coalesce(p_enabled, false)
    )
  );

  return true;
end;
$$;

create or replace function public.reset_event_shirt_inventory(
  p_event_id uuid,
  p_clear_history boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
  v_actor text := coalesce((select email from auth.users where id = auth.uid()), auth.role(), 'system');
  v_before_snapshot jsonb := '[]'::jsonb;
  v_inventory_rows integer := 0;
  v_movements_before integer := 0;
  v_movements_deleted integer := 0;
  v_active_reservations integer := 0;
  v_delivered_kits integer := 0;
  v_confirmed_tickets integer := 0;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_mode text := case when coalesce(p_clear_history, false) then 'full' else 'simple' end;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(p_clear_history, false) then
    if not public.current_user_has_permission('inventory.clear_history'::text) then
      raise exception 'Sem permissao para limpar historico de estoque.';
    end if;
  else
    if not public.current_user_has_permission('inventory.reset'::text) then
      raise exception 'Sem permissao para zerar estoque.';
    end if;
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  perform 1
  from public.shirt_inventory si
  where si.event_id = p_event_id
  for update;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', si.id,
          'shirt_type', si.shirt_type,
          'shirt_size', si.shirt_size,
          'total_quantity', si.total_quantity,
          'reserved_quantity', si.reserved_quantity,
          'delivered_quantity', si.delivered_quantity
        )
        order by si.shirt_type, si.shirt_size
      ),
      '[]'::jsonb
    ),
    count(*)::integer
  into v_before_snapshot, v_inventory_rows
  from public.shirt_inventory si
  where si.event_id = p_event_id;

  select count(*)::integer
  into v_movements_before
  from public.inventory_movements im
  where im.event_id = p_event_id;

  select count(*)::integer
  into v_active_reservations
  from public.order_items oi
  where oi.event_id = p_event_id
    and oi.status = 'reserved';

  select count(*)::integer
  into v_delivered_kits
  from public.participant_kit_items pki
  where pki.event_id = p_event_id
    and pki.status = 'delivered';

  select count(*)::integer
  into v_confirmed_tickets
  from public.tickets t
  where t.event_id = p_event_id
    and t.status in ('active', 'used');

  if coalesce(p_clear_history, false) and (v_delivered_kits > 0 or v_confirmed_tickets > 0) then
    raise exception 'Limpeza de historico bloqueada: existem entregas reais ou tickets confirmados neste evento. Use a zeragem simples.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = 0,
    reserved_quantity = 0,
    delivered_quantity = 0,
    updated_at = now()
  where event_id = p_event_id;

  if coalesce(p_clear_history, false) then
    raise notice '[inventory-reset] ANTES DO DELETE: tabela=public.inventory_movements filtros=event_id:% previsao=%', p_event_id, v_movements_before;

    delete from public.inventory_movements
    where event_id = p_event_id;

    get diagnostics v_movements_deleted = row_count;

    raise notice '[inventory-reset] DEPOIS DO DELETE: tabela=public.inventory_movements removidos=%', v_movements_deleted;
  end if;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_event_reset',
    'events',
    p_event_id,
    p_event_id,
    jsonb_build_object(
      'mode', v_mode,
      'reason', coalesce(v_reason, 'sem motivo informado'),
      'inventory_rows', v_inventory_rows,
      'movements_before', v_movements_before,
      'movements_deleted', v_movements_deleted,
      'active_reservations', v_active_reservations,
      'delivered_kits', v_delivered_kits,
      'confirmed_tickets', v_confirmed_tickets,
      'before_snapshot', v_before_snapshot,
      'cleared_history', coalesce(p_clear_history, false)
    )
  );

  return jsonb_build_object(
    'event_id', p_event_id,
    'mode', v_mode,
    'inventory_rows', v_inventory_rows,
    'movements_before', v_movements_before,
    'movements_deleted', v_movements_deleted,
    'active_reservations', v_active_reservations,
    'delivered_kits', v_delivered_kits,
    'confirmed_tickets', v_confirmed_tickets
  );
end;
$$;

do $$
begin
  if to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)') is null
    and to_regprocedure('public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)') is not null then
    execute 'alter function public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text) rename to create_multi_ticket_order_checkout_legacy';
  end if;
end
$$;

create or replace function public.create_multi_ticket_order_checkout(
  p_event_id uuid,
  p_ticket_category_id uuid,
  p_gender text,
  p_quantity integer,
  p_payment_method text,
  p_coupon_code text default null,
  p_shirt_type text default null,
  p_shirt_size text default null,
  p_buyer_full_name text default null,
  p_buyer_cpf text default null,
  p_buyer_birth_date date default null,
  p_buyer_gender text default null,
  p_buyer_phone text default null,
  p_buyer_email text default null,
  p_buyer_city text default null,
  p_assign_first_to_buyer boolean default true,
  p_items jsonb default '[]'::jsonb,
  p_limit_per_order integer default 10,
  p_notes text default null,
  p_client_request_id text default null
)
returns table (
  order_id uuid,
  payment_id uuid,
  order_number text,
  payment_status text,
  reservation_expires_at timestamptz,
  item_count integer,
  amount numeric,
  discount_amount numeric,
  final_amount numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
  v_limit_stock boolean := false;
  v_item_index integer;
  v_item_payload jsonb;
  v_raw_type text;
  v_raw_size text;
  v_norm_type text;
  v_norm_size text;
  v_variant record;
  v_inventory public.shirt_inventory%rowtype;
  v_required_total integer;
  v_result record;
  v_tmp_rows_before integer := 0;
  v_tmp_rows_after integer := 0;
begin
  if to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)') is null then
    raise exception 'Funcao legacy de checkout nao encontrada.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  v_limit_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  if v_limit_stock then
    return query
    select *
    from public.create_multi_ticket_order_checkout_legacy(
      p_event_id,
      p_ticket_category_id,
      p_gender,
      p_quantity,
      p_payment_method,
      p_coupon_code,
      p_shirt_type,
      p_shirt_size,
      p_buyer_full_name,
      p_buyer_cpf,
      p_buyer_birth_date,
      p_buyer_gender,
      p_buyer_phone,
      p_buyer_email,
      p_buyer_city,
      p_assign_first_to_buyer,
      p_items,
      p_limit_per_order,
      p_notes,
      p_client_request_id
    );
    return;
  end if;

  create temporary table if not exists pg_temp.tmp_inventory_checkout_boost (
    inventory_id uuid primary key,
    original_total integer not null
  ) on commit drop;

  select count(*)::integer
  into v_tmp_rows_before
  from pg_temp.tmp_inventory_checkout_boost;

  raise notice '[checkout-cleanup] ANTES: tabela=pg_temp.tmp_inventory_checkout_boost filtros=nenhum escopo=temp previsao=%', v_tmp_rows_before;

  truncate table pg_temp.tmp_inventory_checkout_boost;

  select count(*)::integer
  into v_tmp_rows_after
  from pg_temp.tmp_inventory_checkout_boost;

  raise notice '[checkout-cleanup] DEPOIS: tabela=pg_temp.tmp_inventory_checkout_boost removidos=% restante=%', (v_tmp_rows_before - v_tmp_rows_after), v_tmp_rows_after;

  for v_item_index in 1..greatest(coalesce(p_quantity, 0), 0) loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    v_raw_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_raw_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

    if v_raw_type is null or v_raw_size is null then
      continue;
    end if;

    if lower(v_raw_type) = 'camiseta' then
      v_norm_type := 'Camiseta';
    elsif lower(v_raw_type) = 'babylook' then
      v_norm_type := 'Babylook';
    else
      v_norm_type := initcap(lower(v_raw_type));
    end if;

    v_norm_size := upper(v_raw_size);

    select * into v_inventory
    from public.shirt_inventory si
    where si.event_id = p_event_id
      and upper(trim(si.shirt_type)) = upper(trim(v_norm_type))
      and upper(trim(si.shirt_size)) = upper(trim(v_norm_size))
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para variante % / %.', v_norm_type, v_norm_size;
    end if;

    insert into pg_temp.tmp_inventory_checkout_boost (inventory_id, original_total)
    values (v_inventory.id, coalesce(v_inventory.total_quantity, 0))
    on conflict (inventory_id) do nothing;
  end loop;

  for v_variant in
    select
      v.inventory_id,
      count(*)::integer as requested_qty
    from (
      select
        si.id as inventory_id
      from generate_series(1, greatest(coalesce(p_quantity, 0), 0)) gs(idx)
      cross join lateral (
        select case
          when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (gs.idx - 1), '{}'::jsonb)
          else '{}'::jsonb
        end as payload
      ) item
      cross join lateral (
        select nullif(trim(coalesce(item.payload ->> 'shirt_type', p_shirt_type, '')), '') as raw_type,
               nullif(trim(coalesce(item.payload ->> 'shirt_size', p_shirt_size, '')), '') as raw_size
      ) raw
      cross join lateral (
        select case
          when raw.raw_type is null then null
          when lower(raw.raw_type) = 'camiseta' then 'Camiseta'
          when lower(raw.raw_type) = 'babylook' then 'Babylook'
          else initcap(lower(raw.raw_type))
        end as norm_type,
        case when raw.raw_size is null then null else upper(raw.raw_size) end as norm_size
      ) normalized
      join public.shirt_inventory si
        on si.event_id = p_event_id
       and upper(trim(si.shirt_type)) = upper(trim(normalized.norm_type))
       and upper(trim(si.shirt_size)) = upper(trim(normalized.norm_size))
      where normalized.norm_type is not null
        and normalized.norm_size is not null
    ) v
    group by v.inventory_id
  loop
    select * into v_inventory
    from public.shirt_inventory
    where id = v_variant.inventory_id
    for update;

    v_required_total := coalesce(v_inventory.reserved_quantity, 0)
      + coalesce(v_inventory.delivered_quantity, 0)
      + coalesce(v_variant.requested_qty, 0);

    if coalesce(v_inventory.total_quantity, 0) < v_required_total then
      update public.shirt_inventory
      set total_quantity = v_required_total,
          updated_at = now()
      where id = v_inventory.id;
    end if;
  end loop;

  begin
    select * into v_result
    from public.create_multi_ticket_order_checkout_legacy(
      p_event_id,
      p_ticket_category_id,
      p_gender,
      p_quantity,
      p_payment_method,
      p_coupon_code,
      p_shirt_type,
      p_shirt_size,
      p_buyer_full_name,
      p_buyer_cpf,
      p_buyer_birth_date,
      p_buyer_gender,
      p_buyer_phone,
      p_buyer_email,
      p_buyer_city,
      p_assign_first_to_buyer,
      p_items,
      p_limit_per_order,
      p_notes,
      p_client_request_id
    )
    limit 1;
  exception
    when others then
      update public.shirt_inventory si
      set total_quantity = boost.original_total,
          updated_at = now()
      from pg_temp.tmp_inventory_checkout_boost boost
      where si.id = boost.inventory_id;
      raise;
  end;

  update public.shirt_inventory si
  set total_quantity = boost.original_total,
      updated_at = now()
  from pg_temp.tmp_inventory_checkout_boost boost
  where si.id = boost.inventory_id;

  return query
  select
    v_result.order_id,
    v_result.payment_id,
    v_result.order_number,
    v_result.payment_status,
    v_result.reservation_expires_at,
    v_result.item_count,
    v_result.amount,
    v_result.discount_amount,
    v_result.final_amount;
end;
$$;

revoke all on function public.set_event_shirt_stock_limit(uuid, boolean) from public, anon, authenticated;
revoke all on function public.reset_event_shirt_inventory(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text) from public, anon;

grant execute on function public.set_event_shirt_stock_limit(uuid, boolean) to authenticated;
grant execute on function public.reset_event_shirt_inventory(uuid, boolean, text) to authenticated;
grant execute on function public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text) to authenticated;
