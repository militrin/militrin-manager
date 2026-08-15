-- 095_event_scoped_generic_schedule.sql
-- Evolui o cronograma global de kits para compromissos genericos por evento.

begin;

do $$
begin
  if exists(select 1 from public.kit_delivery_schedule) then
    raise exception 'A migration 095 nao pode classificar automaticamente cronogramas globais legados. Execute o preflight e defina o event_id de cada linha antes de aplicar.';
  end if;
end; $$;

alter table public.kit_delivery_schedule
  add column if not exists event_id uuid references public.events(id) on delete cascade,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists schedule_type text not null default 'other',
  add column if not exists is_visible_to_users boolean not null default true;

alter table public.kit_delivery_schedule alter column city drop not null;
alter table public.kit_delivery_schedule alter column location drop not null;
alter table public.kit_delivery_schedule alter column event_id set not null;
alter table public.kit_delivery_schedule alter column title set not null;

alter table public.kit_delivery_schedule drop constraint if exists kit_delivery_schedule_type_check;
alter table public.kit_delivery_schedule add constraint kit_delivery_schedule_type_check check(schedule_type in(
  'kit_pickup','gates_open','event_start','attraction','accreditation','meeting','closing','other'
));

create index if not exists idx_kit_delivery_schedule_event_time
  on public.kit_delivery_schedule(event_id,delivery_at) where is_active and is_visible_to_users;

alter table public.kit_delivery_schedule enable row level security;
drop policy if exists kit_delivery_schedule_select on public.kit_delivery_schedule;
create policy kit_delivery_schedule_select on public.kit_delivery_schedule for select to authenticated using(
  exists(
    select 1 from public.tickets t join public.participants p on p.id=t.participant_id
    where t.event_id=kit_delivery_schedule.event_id and p.user_id=auth.uid() and t.status<>'cancelled'
  )
  or exists(
    select 1 from public.events e where e.id=kit_delivery_schedule.event_id
      and public.user_can_access_organization(auth.uid(),e.organization_id)
      and public.current_user_has_permission('events.view')
  )
);

create or replace function public.upsert_event_schedule_item(
  p_event_id uuid,p_delivery_at timestamptz,p_title text,p_location text default null,
  p_description text default null,p_schedule_type text default 'other',p_id uuid default null,
  p_sort_order integer default 0,p_is_active boolean default true,p_is_visible_to_users boolean default true
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_org uuid;
begin
  if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if p_delivery_at is null or nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Data, horario e titulo sao obrigatorios.'; end if;
  if p_schedule_type not in('kit_pickup','gates_open','event_start','attraction','accreditation','meeting','closing','other') then raise exception 'Tipo de compromisso invalido.'; end if;
  if p_id is null then
    insert into public.kit_delivery_schedule(event_id,delivery_at,title,location,description,schedule_type,sort_order,is_active,is_visible_to_users)
    values(p_event_id,p_delivery_at,trim(p_title),nullif(trim(coalesce(p_location,'')),''),nullif(trim(coalesce(p_description,'')),''),p_schedule_type,coalesce(p_sort_order,0),coalesce(p_is_active,true),coalesce(p_is_visible_to_users,true)) returning id into v_id;
  else
    update public.kit_delivery_schedule set delivery_at=p_delivery_at,title=trim(p_title),location=nullif(trim(coalesce(p_location,'')),''),description=nullif(trim(coalesce(p_description,'')),''),schedule_type=p_schedule_type,sort_order=coalesce(p_sort_order,0),is_active=coalesce(p_is_active,true),is_visible_to_users=coalesce(p_is_visible_to_users,true),updated_at=now()
    where id=p_id and event_id=p_event_id returning id into v_id;
    if v_id is null then raise exception 'Compromisso nao encontrado neste evento.'; end if;
  end if;
  return v_id;
end; $$;

create or replace function public.delete_event_schedule_item(p_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_event uuid; v_org uuid;
begin
  select event_id into v_event from public.kit_delivery_schedule where id=p_id;
  select organization_id into v_org from public.events where id=v_event;
  if auth.uid() is null or not public.current_user_has_permission('events.edit') or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Sem permissao.'; end if;
  delete from public.kit_delivery_schedule where id=p_id;
end; $$;

revoke all on function public.upsert_kit_delivery_schedule(timestamptz,text,text,uuid,integer,boolean) from public,anon,authenticated;
revoke all on function public.delete_kit_delivery_schedule(uuid) from public,anon,authenticated;
revoke all on function public.get_upcoming_kit_deliveries(integer) from public,anon,authenticated;
revoke all on function public.upsert_event_schedule_item(uuid,timestamptz,text,text,text,text,uuid,integer,boolean,boolean) from public,anon,authenticated;
revoke all on function public.delete_event_schedule_item(uuid) from public,anon,authenticated;
grant execute on function public.upsert_event_schedule_item(uuid,timestamptz,text,text,text,text,uuid,integer,boolean,boolean) to authenticated;
grant execute on function public.delete_event_schedule_item(uuid) to authenticated;

commit;
