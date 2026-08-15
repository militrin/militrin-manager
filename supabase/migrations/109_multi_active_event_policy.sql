-- 109_multi_active_event_policy.sql
-- Politica canonica de multiplos eventos ativos e arquivamento explicito.
begin;

alter table public.events add column if not exists archived_at timestamptz;
alter table public.events add column if not exists archived_by uuid references auth.users(id) on delete set null;

drop index if exists public.ux_events_single_active;

create or replace function public.create_event(
  p_name text,p_slug text,p_year integer default null,p_description text default null,
  p_starts_at timestamptz default null,p_ends_at timestamptz default null,
  p_registration_open_at timestamptz default null,p_registration_close_at timestamptz default null,
  p_location text default null,p_is_active boolean default false,
  p_registration_enabled boolean default false,p_kit_enabled boolean default false,
  p_organization_id uuid default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_org uuid; v_id uuid; v_slug text;
begin
  if v_actor is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if not public.current_user_has_permission('events.edit') then raise exception 'Permissao insuficiente para criar evento.'; end if;
  v_org:=coalesce(p_organization_id,public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor,v_org) then raise exception 'Acesso negado a organizacao.'; end if;
  if coalesce(p_is_active,false) or coalesce(p_registration_enabled,false) then
    if not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para publicar evento.'; end if;
  end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nome do evento obrigatorio.'; end if;
  v_slug:=public.slugify_text(coalesce(nullif(trim(p_slug),''),p_name||'-'||coalesce(p_year::text,extract(year from now())::text)));
  if v_slug='' then raise exception 'Slug do evento invalido.'; end if;
  insert into public.events(name,slug,year,description,starts_at,ends_at,registration_open_at,
    registration_close_at,location,is_active,registration_enabled,kit_enabled,organization_id,archived_at,archived_by)
  values(trim(p_name),v_slug,p_year,nullif(trim(coalesce(p_description,'')),''),p_starts_at,p_ends_at,
    p_registration_open_at,p_registration_close_at,nullif(trim(coalesce(p_location,'')),''),
    coalesce(p_is_active,false),coalesce(p_registration_enabled,false),coalesce(p_kit_enabled,false),v_org,null,null)
  returning id into v_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_created','events',v_id,v_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_org,
      'previous_state',null,'new_state',jsonb_build_object('is_active',coalesce(p_is_active,false),
      'registration_enabled',coalesce(p_registration_enabled,false),'archived_at',null)));
  return v_id;
end; $$;

create or replace function public.update_event(
  p_event_id uuid,p_name text,p_slug text,p_year integer default null,p_description text default null,
  p_starts_at timestamptz default null,p_ends_at timestamptz default null,
  p_registration_open_at timestamptz default null,p_registration_close_at timestamptz default null,
  p_location text default null,p_is_active boolean default false,
  p_registration_enabled boolean default false,p_kit_enabled boolean default false
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_slug text;
begin
  if v_actor is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if not public.current_user_has_permission('events.edit') then raise exception 'Permissao insuficiente para editar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado deve ser restaurado antes da edicao.'; end if;
  if coalesce(p_is_active,false) is distinct from v_event.is_active
    or coalesce(p_registration_enabled,false) is distinct from v_event.registration_enabled then
    raise exception 'Use as operacoes especificas para ativacao e vendas.';
  end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nome do evento obrigatorio.'; end if;
  v_slug:=public.slugify_text(coalesce(nullif(trim(p_slug),''),p_name||'-'||coalesce(p_year::text,extract(year from now())::text)));
  update public.events set name=trim(p_name),slug=v_slug,year=p_year,
    description=nullif(trim(coalesce(p_description,'')),''),starts_at=p_starts_at,ends_at=p_ends_at,
    registration_open_at=p_registration_open_at,registration_close_at=p_registration_close_at,
    location=nullif(trim(coalesce(p_location,'')),''),is_active=coalesce(p_is_active,false),
    registration_enabled=coalesce(p_registration_enabled,false),kit_enabled=coalesce(p_kit_enabled,false),updated_at=now()
  where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_updated','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,
      'organization_id',v_event.organization_id,'previous_state',jsonb_build_object('name',v_event.name,'slug',v_event.slug,
      'is_active',v_event.is_active,'registration_enabled',v_event.registration_enabled,'kit_enabled',v_event.kit_enabled),
      'new_state',jsonb_build_object('name',trim(p_name),'slug',v_slug,'is_active',coalesce(p_is_active,false),
      'registration_enabled',coalesce(p_registration_enabled,false),'kit_enabled',coalesce(p_kit_enabled,false))));
  return true;
end; $$;

create or replace function public.set_event_active(p_event_id uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para ativar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado nao pode ser ativado.'; end if;
  if v_event.is_active then return true; end if;
  update public.events set is_active=true,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_activated','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',false),'new_state',jsonb_build_object('is_active',true)));
  return true;
end; $$;

create or replace function public.set_event_inactive(p_event_id uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para desativar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado nao aceita alteracao operacional.'; end if;
  if not v_event.is_active then return true; end if;
  update public.events set is_active=false,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_deactivated','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',true),'new_state',jsonb_build_object('is_active',false)));
  return true;
end; $$;

create or replace function public.set_event_registration_enabled(p_event_id uuid,p_enabled boolean) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_enabled boolean:=coalesce(p_enabled,false);
begin
  if v_actor is null or not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para alterar vendas.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado nao pode abrir vendas.'; end if;
  if v_event.registration_enabled=v_enabled then return true; end if;
  update public.events set registration_enabled=v_enabled,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    (case when v_enabled then 'event_sales_opened' else 'event_sales_closed' end,'events',p_event_id,p_event_id,
      jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('registration_enabled',v_event.registration_enabled),
      'new_state',jsonb_build_object('registration_enabled',v_enabled)));
  return true;
end; $$;

create or replace function public.archive_event(p_event_id uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_now timestamptz:=now();
begin
  if v_actor is null or not public.current_user_has_permission('events.archive') then raise exception 'Permissao insuficiente para arquivar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then return true; end if;
  update public.events set is_active=false,registration_enabled=false,archived_at=v_now,archived_by=v_actor,updated_at=v_now where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_archived','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',v_event.is_active,'registration_enabled',v_event.registration_enabled,'archived_at',null),
      'new_state',jsonb_build_object('is_active',false,'registration_enabled',false,'archived_at',v_now)));
  return true;
end; $$;

create or replace function public.restore_event(p_event_id uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.archive') then raise exception 'Permissao insuficiente para restaurar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is null then return true; end if;
  update public.events set is_active=false,registration_enabled=false,archived_at=null,archived_by=null,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_restored','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',false,'registration_enabled',false,'archived_at',v_event.archived_at),
      'new_state',jsonb_build_object('is_active',false,'registration_enabled',false,'archived_at',null)));
  return true;
end; $$;

revoke all on function public.create_event(text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean,uuid) from public,anon,authenticated;
revoke all on function public.update_event(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean) from public,anon,authenticated;
revoke all on function public.set_event_active(uuid) from public,anon,authenticated;
revoke all on function public.set_event_inactive(uuid) from public,anon,authenticated;
revoke all on function public.set_event_registration_enabled(uuid,boolean) from public,anon,authenticated;
revoke all on function public.archive_event(uuid) from public,anon,authenticated;
revoke all on function public.restore_event(uuid) from public,anon,authenticated;
grant execute on function public.create_event(text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean,uuid) to authenticated;
grant execute on function public.update_event(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean) to authenticated;
grant execute on function public.set_event_active(uuid),public.set_event_inactive(uuid),public.set_event_registration_enabled(uuid,boolean),public.archive_event(uuid),public.restore_event(uuid) to authenticated;

-- Fecha grants anonimos herdados de RPCs mutaveis de configuracao de evento.
do $$ declare v_proc record; begin
  for v_proc in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in(
      'upsert_event_kit_item','delete_event_kit_item','upsert_event_kit_item_variant','delete_event_kit_item_variant',
      'duplicate_event_configuration','upsert_event_highlight','remove_event_highlight','upsert_event_payment_methods',
      'upsert_event_addons_config','upsert_event_addons_model','upsert_event_addon_option','delete_event_addon_option',
      'upsert_event_batch_addon_option','set_event_shirt_stock_limit','reset_event_shirt_inventory',
      'set_event_participant_item_changes','set_event_kit_item_change_rules','set_event_kit_item_variant_stock',
      'set_event_ticket_holder_rules','upsert_event_schedule_item','delete_event_schedule_item'
    )
  loop execute format('revoke all on function %s from public, anon',v_proc.signature); end loop;
end $$;

commit;
