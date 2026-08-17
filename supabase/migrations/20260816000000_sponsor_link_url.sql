-- Link do patrocinador (ex.: site institucional): para onde o clique no
-- banner da Home redireciona. Nulo = banner nao clicavel (mesma logica de
-- banner_url ausente = sem banner). A 20260815006600_sponsors_module.sql ja
-- foi aplicada no remoto, entao qualquer ajuste de schema/RPC entra aqui
-- como migration nova, nunca editando a anterior.
begin;

alter table public.sponsors
  add column if not exists link_url text;

comment on column public.sponsors.link_url is
  'URL para onde o clique no banner do patrocinador redireciona (ex.: site institucional). Nulo = banner nao clicavel.';

-- admin_upsert_sponsor ganha p_link_url no fim: assinatura muda (5 -> 6
-- parametros), entao precisa dropar a antiga para nao deixar overload
-- ambiguo (mesmo padrao ja usado em create_registration_batch).
drop function if exists public.admin_upsert_sponsor(uuid, uuid, text, boolean, integer);

create or replace function public.admin_upsert_sponsor(
  p_id uuid, p_organization_id uuid, p_name text, p_is_active boolean, p_sort_order integer, p_link_url text default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid; v_id uuid; v_previous public.sponsors%rowtype; v_link_url text;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  v_org := coalesce(p_organization_id, public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome do patrocinador obrigatorio.'; end if;

  v_link_url := nullif(trim(coalesce(p_link_url, '')), '');
  if v_link_url is not null and v_link_url !~* '^https?://\S+$' then
    raise exception 'Link do patrocinador deve comecar com http:// ou https://.';
  end if;

  if p_id is null then
    insert into public.sponsors (organization_id, name, is_active, sort_order, link_url)
    values (v_org, trim(p_name), coalesce(p_is_active, true), coalesce(p_sort_order, 0), v_link_url)
    returning id into v_id;
    insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
      ('sponsor_created', 'sponsors', v_id, null, jsonb_build_object('actor_user_id', v_actor, 'organization_id', v_org, 'name', trim(p_name), 'link_url', v_link_url));
  else
    select * into v_previous from public.sponsors where id = p_id for update;
    if not found or v_previous.organization_id <> v_org then raise exception 'Patrocinador nao encontrado.'; end if;
    update public.sponsors set name = trim(p_name), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), link_url = v_link_url, updated_at = now()
    where id = p_id
    returning id into v_id;
    insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
      ('sponsor_updated', 'sponsors', v_id, null, jsonb_build_object('actor_user_id', v_actor, 'organization_id', v_org,
        'previous_state', jsonb_build_object('name', v_previous.name, 'is_active', v_previous.is_active, 'sort_order', v_previous.sort_order, 'link_url', v_previous.link_url),
        'new_state', jsonb_build_object('name', trim(p_name), 'is_active', coalesce(p_is_active, true), 'sort_order', coalesce(p_sort_order, 0), 'link_url', v_link_url)));
  end if;
  return v_id;
end; $$;

revoke all on function public.admin_upsert_sponsor(uuid, uuid, text, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.admin_upsert_sponsor(uuid, uuid, text, boolean, integer, text) to authenticated;

-- list_sponsors_for_admin ganha link_url na tabela de retorno: o retorno
-- muda, entao tambem precisa dropar antes de recriar.
drop function if exists public.list_sponsors_for_admin(uuid);

create or replace function public.list_sponsors_for_admin(p_organization_id uuid default null)
returns table(
  sponsor_id uuid, name text, banner_url text, link_url text, is_active boolean, sort_order integer,
  user_id uuid, user_full_name text, user_email text, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.view') then
    raise exception 'Sem permissao para ver patrocinadores.';
  end if;
  v_org := coalesce(p_organization_id, public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;

  return query
  select s.id, s.name, s.banner_url, s.link_url, s.is_active, s.sort_order,
    s.user_id, coalesce(nullif(trim(cp.full_name), ''), nullif(trim(au.raw_user_meta_data->>'full_name'), '')),
    au.email::text, s.created_at, s.updated_at
  from public.sponsors s
  left join auth.users au on au.id = s.user_id
  left join public.customer_profiles cp on cp.user_id = s.user_id
  where s.organization_id = v_org
  order by s.sort_order, s.name;
end; $$;

revoke all on function public.list_sponsors_for_admin(uuid) from public, anon;
grant execute on function public.list_sponsors_for_admin(uuid) to authenticated;

-- get_my_sponsor_profile ganha link_url: retorno muda, precisa dropar.
drop function if exists public.get_my_sponsor_profile();

create or replace function public.get_my_sponsor_profile()
returns table(sponsor_id uuid, organization_id uuid, organization_name text, name text, banner_url text, link_url text, is_active boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.organization_id, o.name, s.name, s.banner_url, s.link_url, s.is_active
  from public.sponsors s
  join public.organizations o on o.id = s.organization_id
  where s.user_id = auth.uid();
$$;

revoke all on function public.get_my_sponsor_profile() from public, anon;
grant execute on function public.get_my_sponsor_profile() to authenticated;

-- Autoatendimento: o proprio patrocinador atualiza o proprio link, sempre
-- resolvido por auth.uid() -- nunca aceita sponsor_id do client (mesmo
-- padrao de update_my_sponsor_banner).
create or replace function public.update_my_sponsor_link(p_link_url text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_sponsor public.sponsors%rowtype; v_link_url text;
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  select * into v_sponsor from public.sponsors where user_id = v_actor for update;
  if not found then raise exception 'Nenhum patrocinador vinculado a esta conta.'; end if;
  v_link_url := nullif(trim(coalesce(p_link_url, '')), '');
  if v_link_url is not null and v_link_url !~* '^https?://\S+$' then
    raise exception 'Link do patrocinador deve comecar com http:// ou https://.';
  end if;
  update public.sponsors set link_url = v_link_url, updated_at = now() where id = v_sponsor.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
    ('sponsor_link_updated', 'sponsors', v_sponsor.id, null, jsonb_build_object('actor_user_id', v_actor,
      'organization_id', v_sponsor.organization_id, 'origin', 'self_service'));
end; $$;

revoke all on function public.update_my_sponsor_link(text) from public, anon, authenticated;
grant execute on function public.update_my_sponsor_link(text) to authenticated;

-- get_active_sponsors_for_home ganha link_url: retorno muda, precisa dropar.
drop function if exists public.get_active_sponsors_for_home();

create or replace function public.get_active_sponsors_for_home()
returns table(sponsor_id uuid, name text, banner_url text, link_url text, sort_order integer, carousel_interval_seconds integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.name, s.banner_url, s.link_url, s.sort_order, o.sponsor_carousel_interval_seconds
  from public.sponsors s
  join public.organizations o on o.id = s.organization_id
  where s.is_active = true and s.banner_url is not null
  order by s.sort_order, s.name;
$$;

revoke all on function public.get_active_sponsors_for_home() from public, anon;
grant execute on function public.get_active_sponsors_for_home() to authenticated;

commit;
