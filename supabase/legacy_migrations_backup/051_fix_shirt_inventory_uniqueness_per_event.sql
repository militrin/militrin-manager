-- 051_fix_shirt_inventory_uniqueness_per_event.sql
-- Remove legacy global uniqueness on shirt inventory and enforce uniqueness per event.

begin;

-- 1) Drop known legacy constraint/index names when present.
alter table if exists public.shirt_inventory
  drop constraint if exists shirt_inventory_unique;

drop index if exists public.shirt_inventory_unique;

drop index if exists public.ux_shirt_inventory_type_size;

-- 2) Drop any other UNIQUE indexes that enforce only (shirt_type, shirt_size)
--    and do not include event_id.
do $$
declare
  v_index_name text;
  v_index_def text;
begin
  for v_index_name, v_index_def in
    select
      idx.relname,
      pg_get_indexdef(i.indexrelid)
    from pg_index i
    join pg_class tbl on tbl.oid = i.indrelid
    join pg_namespace ns on ns.oid = tbl.relnamespace
    join pg_class idx on idx.oid = i.indexrelid
    where ns.nspname = 'public'
      and tbl.relname = 'shirt_inventory'
      and i.indisunique = true
  loop
    if v_index_def ilike '%shirt_type%'
       and v_index_def ilike '%shirt_size%'
       and v_index_def not ilike '%event_id%'
    then
      execute format('drop index if exists public.%I', v_index_name);
    end if;
  end loop;
end
$$;

-- 3) Consolidate duplicate rows by (event_id, shirt_type, shirt_size),
--    preserving one row and moving inventory_movements references.
with ranked as (
  select
    si.id,
    si.event_id,
    si.shirt_type,
    si.shirt_size,
    si.total_quantity,
    si.reserved_quantity,
    si.delivered_quantity,
    first_value(si.id) over (
      partition by si.event_id, si.shirt_type, si.shirt_size
      order by si.created_at asc, si.id asc
    ) as keeper_id,
    row_number() over (
      partition by si.event_id, si.shirt_type, si.shirt_size
      order by si.created_at asc, si.id asc
    ) as rn
  from public.shirt_inventory si
), merged as (
  select
    event_id,
    shirt_type,
    shirt_size,
    keeper_id,
    sum(total_quantity)::integer as total_quantity,
    sum(reserved_quantity)::integer as reserved_quantity,
    sum(delivered_quantity)::integer as delivered_quantity
  from ranked
  group by event_id, shirt_type, shirt_size, keeper_id
), updated_keeper as (
  update public.shirt_inventory si
     set total_quantity = m.total_quantity,
         reserved_quantity = m.reserved_quantity,
         delivered_quantity = m.delivered_quantity,
         updated_at = now()
    from merged m
   where si.id = m.keeper_id
  returning si.id
), moved_movements as (
  update public.inventory_movements im
     set inventory_id = r.keeper_id
    from ranked r
   where r.rn > 1
     and im.inventory_id = r.id
  returning im.id
)
delete from public.shirt_inventory si
using ranked r
where r.rn > 1
  and si.id = r.id;

-- 4) Enforce event-scoped uniqueness.
create unique index if not exists ux_shirt_inventory_event_type_size
  on public.shirt_inventory (event_id, shirt_type, shirt_size);

commit;
