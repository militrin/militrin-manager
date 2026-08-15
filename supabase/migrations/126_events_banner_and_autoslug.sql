-- 126_events_banner_and_autoslug.sql
-- 1) Slug de evento passa a ser sempre gerado/deduplicado pelo sistema: nem
--    create_event nem update_event mais confiam em um slug unico vindo do
--    client sem checagem -- se o slug derivado do nome colidir com um
--    evento existente, um sufixo numerico (-2, -3, ...) e anexado
--    automaticamente ate achar um livre. p_slug continua aceito como uma
--    preferencia opcional (usado por duplicar evento, que ja monta um slug
--    proprio a partir do novo nome), mas a tela de criar/editar evento para
--    de mandar esse campo.
-- 2) Dois banners por evento: banner_hero_url (topo da pagina publica do
--    evento e da inscricao) e banner_card_url (miniatura do card na
--    listagem publica).

begin;

alter table public.events add column if not exists banner_hero_url text;
alter table public.events add column if not exists banner_card_url text;

-- ============================================================
-- create_event: slug deduplicado automaticamente + banners.
-- ============================================================

drop function if exists public.create_event(text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean,uuid,integer);

create or replace function public.create_event(
  p_name text,p_slug text,p_year integer default null,p_description text default null,
  p_starts_at timestamptz default null,p_ends_at timestamptz default null,
  p_registration_open_at timestamptz default null,p_registration_close_at timestamptz default null,
  p_location text default null,p_is_active boolean default false,
  p_registration_enabled boolean default false,p_kit_enabled boolean default false,
  p_organization_id uuid default null,p_min_age integer default 18,
  p_banner_hero_url text default null,p_banner_card_url text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_org uuid; v_id uuid; v_base_slug text; v_slug text; v_suffix integer:=1;
begin
  if v_actor is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if not public.current_user_has_permission('events.edit') then raise exception 'Permissao insuficiente para criar evento.'; end if;
  v_org:=coalesce(p_organization_id,public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor,v_org) then raise exception 'Acesso negado a organizacao.'; end if;
  if coalesce(p_is_active,false) or coalesce(p_registration_enabled,false) then
    if not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para publicar evento.'; end if;
  end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nome do evento obrigatorio.'; end if;
  if coalesce(p_min_age,0) < 0 then raise exception 'Idade minima invalida.'; end if;
  v_base_slug:=public.slugify_text(coalesce(nullif(trim(p_slug),''),p_name||'-'||coalesce(p_year::text,extract(year from now())::text)));
  if v_base_slug='' then raise exception 'Slug do evento invalido.'; end if;
  v_slug:=v_base_slug;
  while exists(select 1 from public.events where slug=v_slug) loop
    v_suffix:=v_suffix+1;
    v_slug:=v_base_slug||'-'||v_suffix::text;
  end loop;
  insert into public.events(name,slug,year,description,starts_at,ends_at,registration_open_at,
    registration_close_at,location,is_active,registration_enabled,kit_enabled,organization_id,archived_at,archived_by,min_age,
    banner_hero_url,banner_card_url)
  values(trim(p_name),v_slug,p_year,nullif(trim(coalesce(p_description,'')),''),p_starts_at,p_ends_at,
    p_registration_open_at,p_registration_close_at,nullif(trim(coalesce(p_location,'')),''),
    coalesce(p_is_active,false),coalesce(p_registration_enabled,false),coalesce(p_kit_enabled,false),v_org,null,null,coalesce(p_min_age,18),
    nullif(trim(coalesce(p_banner_hero_url,'')),''),nullif(trim(coalesce(p_banner_card_url,'')),''))
  returning id into v_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_created','events',v_id,v_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_org,
      'previous_state',null,'new_state',jsonb_build_object('is_active',coalesce(p_is_active,false),
      'registration_enabled',coalesce(p_registration_enabled,false),'archived_at',null)));
  return v_id;
end; $$;

revoke all on function public.create_event(text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.create_event(text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean,uuid,integer,text,text) to authenticated;

-- ============================================================
-- update_event: slug deduplicado automaticamente (exclui o proprio evento
-- da checagem de colisao) + banners.
-- ============================================================

drop function if exists public.update_event(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean);

create or replace function public.update_event(
  p_event_id uuid,p_name text,p_slug text,p_year integer default null,p_description text default null,
  p_starts_at timestamptz default null,p_ends_at timestamptz default null,
  p_registration_open_at timestamptz default null,p_registration_close_at timestamptz default null,
  p_location text default null,p_is_active boolean default false,
  p_registration_enabled boolean default false,p_kit_enabled boolean default false,
  p_banner_hero_url text default null,p_banner_card_url text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_base_slug text; v_slug text; v_suffix integer:=1;
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
  v_base_slug:=public.slugify_text(coalesce(nullif(trim(p_slug),''),p_name||'-'||coalesce(p_year::text,extract(year from now())::text)));
  if v_base_slug='' then raise exception 'Slug do evento invalido.'; end if;
  v_slug:=v_base_slug;
  while exists(select 1 from public.events where slug=v_slug and id<>p_event_id) loop
    v_suffix:=v_suffix+1;
    v_slug:=v_base_slug||'-'||v_suffix::text;
  end loop;
  update public.events set name=trim(p_name),slug=v_slug,year=p_year,
    description=nullif(trim(coalesce(p_description,'')),''),starts_at=p_starts_at,ends_at=p_ends_at,
    registration_open_at=p_registration_open_at,registration_close_at=p_registration_close_at,
    location=nullif(trim(coalesce(p_location,'')),''),is_active=coalesce(p_is_active,false),
    registration_enabled=coalesce(p_registration_enabled,false),kit_enabled=coalesce(p_kit_enabled,false),
    banner_hero_url=nullif(trim(coalesce(p_banner_hero_url,'')),''),banner_card_url=nullif(trim(coalesce(p_banner_card_url,'')),''),
    updated_at=now()
  where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_updated','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,
      'organization_id',v_event.organization_id,'previous_state',jsonb_build_object('name',v_event.name,'slug',v_event.slug,
      'is_active',v_event.is_active,'registration_enabled',v_event.registration_enabled,'kit_enabled',v_event.kit_enabled),
      'new_state',jsonb_build_object('name',trim(p_name),'slug',v_slug,'is_active',coalesce(p_is_active,false),
      'registration_enabled',coalesce(p_registration_enabled,false),'kit_enabled',coalesce(p_kit_enabled,false))));
  return true;
end; $$;

revoke all on function public.update_event(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean,text,text) from public,anon,authenticated;
grant execute on function public.update_event(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz,timestamptz,text,boolean,boolean,boolean,text,text) to authenticated;

-- ============================================================
-- Bucket de storage para os banners: "event-banners" -- assim como
-- "store-item-images" (117), o bucket em si e criado fora de migration
-- (supabase.storage.createBucket, publico) -- esta migration so garante as
-- policies de leitura publica e escrita restrita a quem tem events.edit.
-- ============================================================

drop policy if exists "event_banners_public_read" on storage.objects;
create policy "event_banners_public_read"
on storage.objects for select
using (bucket_id = 'event-banners');

drop policy if exists "event_banners_manage_insert" on storage.objects;
create policy "event_banners_manage_insert"
on storage.objects for insert
to authenticated
with check (bucket_id = 'event-banners' and public.current_user_has_permission('events.edit'));

drop policy if exists "event_banners_manage_update" on storage.objects;
create policy "event_banners_manage_update"
on storage.objects for update
to authenticated
using (bucket_id = 'event-banners' and public.current_user_has_permission('events.edit'));

drop policy if exists "event_banners_manage_delete" on storage.objects;
create policy "event_banners_manage_delete"
on storage.objects for delete
to authenticated
using (bucket_id = 'event-banners' and public.current_user_has_permission('events.edit'));

commit;
