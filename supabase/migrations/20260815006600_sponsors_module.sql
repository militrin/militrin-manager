-- Modulo de Patrocinadores.
--
-- Arquitetura reaproveitada do que ja existe (ver investigacao previa):
-- - organization_id + user_can_access_organization(): mesmo padrao usado por
--   create_event/upsert_store_item para escopar escrita administrativa por
--   organizacao, sem confiar em organization_id vindo do client sem validacao.
-- - admin_permissions/admin_role_permissions + current_user_has_permission():
--   mesmo RBAC ja usado em toda RPC de escrita administrativa (sponsors.view/
--   sponsors.manage seguem exatamente o padrao de store.view/store.manage).
-- - audit_logs (action/entity_type/entity_id/event_id/details com
--   actor_user_id): mesma convencao de auditoria ja usada na maioria das
--   tabelas do sistema (nao criamos colunas created_by/updated_by novas --
--   a maioria das tabelas nao tem, autoria fica em audit_logs).
-- - RLS "select proprio ou da organizacao, escrita so via RPC security
--   definer": mesmo padrao de store_items/store_orders.
--
-- Titularidade do patrocinador (contato externo, nao-staff) e DELIBERADAMENTE
-- independente de admin_users/admin_roles: um usuario vinculado como
-- patrocinador (sponsors.user_id) nunca ganha entrada em admin_users e nunca
-- passa a bater em nenhuma admin_permissions -- e por isso que ele nunca
-- acessa eventos/financeiro/pedidos/cadastros/estoque/equipe "por causa
-- dessa funcao": essas areas sao guardadas por current_user_has_permission
-- (que exige uma linha ativa em admin_users), nunca por sponsors.user_id.
-- Se a mesma pessoa tambem for staff de verdade (admin_users proprio,
-- independente), os dois accessos convivem sem se misturar -- exatamente
-- "as permissoes se acumulam conforme o RBAC existente" pedido.
begin;

-- ============================================================
-- 1. organizations: intervalo do carrossel de patrocinadores (configuravel
--    pelo admin, default 4s). Vive na propria organizations por ser uma
--    preferencia por-organizacao (nao global como platform_settings, que e
--    singleton) e por nao justificar uma tabela de settings nova so para 1
--    campo.
-- ============================================================

alter table public.organizations
  add column if not exists sponsor_carousel_interval_seconds integer not null default 4
    check (sponsor_carousel_interval_seconds between 2 and 30);

-- ============================================================
-- 2. Tabela sponsors
-- ============================================================

create table if not exists public.sponsors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  banner_url text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sponsors_org_active_sort on public.sponsors (organization_id, is_active, sort_order, name);
-- No maximo 1 patrocinador por usuario (nao a mesma coisa que "1 banner
-- ativo por patrocinador" -- essa regra e satisfeita pela propria coluna
-- banner_url ser unica por linha, sem tabela de versoes).
create unique index if not exists ux_sponsors_user_id on public.sponsors (user_id) where user_id is not null;

alter table public.sponsors enable row level security;

drop policy if exists "sponsors_select" on public.sponsors;
create policy "sponsors_select" on public.sponsors for select to authenticated
  using (
    user_id = auth.uid()
    or public.user_can_access_organization(auth.uid(), organization_id)
  );

-- Nenhuma policy de insert/update/delete: toda escrita passa pelas RPCs
-- security definer abaixo (mesmo padrao de store_items/store_orders).

-- ============================================================
-- 3. Bucket de storage "sponsor-banners"
--
-- Diferente de event-banners/store-item-images (buckets criados fora de
-- migration, historicamente via dashboard), este bucket precisa existir de
-- forma reproduzivel em `supabase db reset` local -- por isso e criado aqui
-- via insert direto em storage.buckets (mecanismo suportado nativamente
-- pelo Storage, nao um hack). file_size_limit e allowed_mime_types sao
-- enforcados pela propria API de Storage (nao apenas RLS): endereça
-- diretamente "possuir limite de tamanho" e "aceitar somente formatos de
-- imagem adequados", uma validacao que event-banners/store-item-images nao
-- tinham.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sponsor-banners', 'sponsor-banners', true, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: "{sponsor_id}/{arquivo}". Ao contrario de event-banners
-- (que so checa a permissao RBAC do ator, sem olhar o path -- aceitavel la
-- porque so staff com events.edit escreve nele), aqui o path E a fronteira
-- de seguranca entre patrocinadores: um patrocinador so pode escrever
-- dentro da propria pasta (seu proprio sponsors.id), nunca na de outro.
-- Staff com sponsors.manage pode escrever em qualquer pasta (uso
-- administrativo: "substituir/remover banner" de qualquer patrocinador).
drop policy if exists "sponsor_banners_public_read" on storage.objects;
create policy "sponsor_banners_public_read"
on storage.objects for select
using (bucket_id = 'sponsor-banners');

drop policy if exists "sponsor_banners_owner_or_staff_insert" on storage.objects;
create policy "sponsor_banners_owner_or_staff_insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'sponsor-banners'
  and exists (
    select 1 from public.sponsors s
    where s.id::text = (storage.foldername(storage.objects.name))[1]
      and (s.user_id = auth.uid() or public.current_user_has_permission('sponsors.manage'))
  )
);

drop policy if exists "sponsor_banners_owner_or_staff_update" on storage.objects;
create policy "sponsor_banners_owner_or_staff_update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'sponsor-banners'
  and exists (
    select 1 from public.sponsors s
    where s.id::text = (storage.foldername(storage.objects.name))[1]
      and (s.user_id = auth.uid() or public.current_user_has_permission('sponsors.manage'))
  )
);

drop policy if exists "sponsor_banners_owner_or_staff_delete" on storage.objects;
create policy "sponsor_banners_owner_or_staff_delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'sponsor-banners'
  and exists (
    select 1 from public.sponsors s
    where s.id::text = (storage.foldername(storage.objects.name))[1]
      and (s.user_id = auth.uid() or public.current_user_has_permission('sponsors.manage'))
  )
);

-- ============================================================
-- 4. Permissoes (mesmo padrao de store.view/store.manage)
-- ============================================================

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('sponsors.view', 'Ver patrocinadores', 'Visualiza a lista de patrocinadores da organizacao', 'sponsors', 10, true),
  ('sponsors.manage', 'Gerenciar patrocinadores', 'Cria/edita patrocinadores, vincula usuario, gerencia banner e intervalo do carrossel', 'sponsors', 20, true)
on conflict (code) do update set name = excluded.name, description = excluded.description, module = excluded.module, sort_order = excluded.sort_order, is_active = excluded.is_active;

insert into public.admin_role_permissions (role_id, permission_id)
select ar.id, ap.id
from public.admin_roles ar
join public.admin_permissions ap on ap.code in ('sponsors.view', 'sponsors.manage')
where ar.code = 'administrator'
on conflict (role_id, permission_id) do nothing;

-- ============================================================
-- 5. RPCs administrativas (staff da organizacao, sponsors.view/sponsors.manage)
-- ============================================================

create or replace function public.list_sponsors_for_admin(p_organization_id uuid default null)
returns table(
  sponsor_id uuid, name text, banner_url text, is_active boolean, sort_order integer,
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
  select s.id, s.name, s.banner_url, s.is_active, s.sort_order,
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

create or replace function public.admin_upsert_sponsor(
  p_id uuid, p_organization_id uuid, p_name text, p_is_active boolean, p_sort_order integer
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid; v_id uuid; v_previous public.sponsors%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  v_org := coalesce(p_organization_id, public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome do patrocinador obrigatorio.'; end if;

  if p_id is null then
    insert into public.sponsors (organization_id, name, is_active, sort_order)
    values (v_org, trim(p_name), coalesce(p_is_active, true), coalesce(p_sort_order, 0))
    returning id into v_id;
    insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
      ('sponsor_created', 'sponsors', v_id, null, jsonb_build_object('actor_user_id', v_actor, 'organization_id', v_org, 'name', trim(p_name)));
  else
    select * into v_previous from public.sponsors where id = p_id for update;
    if not found or v_previous.organization_id <> v_org then raise exception 'Patrocinador nao encontrado.'; end if;
    update public.sponsors set name = trim(p_name), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), updated_at = now()
    where id = p_id
    returning id into v_id;
    insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
      ('sponsor_updated', 'sponsors', v_id, null, jsonb_build_object('actor_user_id', v_actor, 'organization_id', v_org,
        'previous_state', jsonb_build_object('name', v_previous.name, 'is_active', v_previous.is_active, 'sort_order', v_previous.sort_order),
        'new_state', jsonb_build_object('name', trim(p_name), 'is_active', coalesce(p_is_active, true), 'sort_order', coalesce(p_sort_order, 0))));
  end if;
  return v_id;
end; $$;

revoke all on function public.admin_upsert_sponsor(uuid, uuid, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.admin_upsert_sponsor(uuid, uuid, text, boolean, integer) to authenticated;

-- p_user_id=null desvincula. Nunca aceita organization_id do client: deriva
-- sempre da linha do patrocinador ja existente.
create or replace function public.admin_set_sponsor_user(p_sponsor_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_sponsor public.sponsors%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  select * into v_sponsor from public.sponsors where id = p_sponsor_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_sponsor.organization_id) then
    raise exception 'Patrocinador nao encontrado.';
  end if;
  if p_user_id is not null and exists (select 1 from public.sponsors where user_id = p_user_id and id <> p_sponsor_id) then
    raise exception 'Este usuario ja esta vinculado a outro patrocinador.';
  end if;
  update public.sponsors set user_id = p_user_id, updated_at = now() where id = p_sponsor_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
    ('sponsor_user_linked', 'sponsors', p_sponsor_id, null, jsonb_build_object('actor_user_id', v_actor,
      'organization_id', v_sponsor.organization_id, 'previous_user_id', v_sponsor.user_id, 'new_user_id', p_user_id));
end; $$;

revoke all on function public.admin_set_sponsor_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_sponsor_user(uuid, uuid) to authenticated;

-- Uso administrativo: forcar/limpar o banner de QUALQUER patrocinador da
-- organizacao (o upload em si vai direto para o Storage a partir do client;
-- esta RPC so grava a URL resultante, mesmo padrao de create_event/
-- update_event com banner_hero_url/banner_card_url).
create or replace function public.admin_set_sponsor_banner(p_sponsor_id uuid, p_banner_url text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_sponsor public.sponsors%rowtype; v_banner_url text;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  select * into v_sponsor from public.sponsors where id = p_sponsor_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_sponsor.organization_id) then
    raise exception 'Patrocinador nao encontrado.';
  end if;
  v_banner_url := nullif(trim(coalesce(p_banner_url, '')), '');
  -- A URL precisa apontar para a propria pasta deste patrocinador no bucket
  -- sponsor-banners (mesmo padrao de path usado no upload/RLS de Storage) --
  -- impede que um banner "emprestado" de outro patrocinador seja referenciado
  -- aqui, mesmo o bucket sendo publico para leitura.
  if v_banner_url is not null and position('/sponsor-banners/' || v_sponsor.id::text || '/' in v_banner_url) = 0 then
    raise exception 'URL de banner invalida para este patrocinador.';
  end if;
  update public.sponsors set banner_url = v_banner_url, updated_at = now() where id = p_sponsor_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
    ('sponsor_banner_updated', 'sponsors', p_sponsor_id, null, jsonb_build_object('actor_user_id', v_actor,
      'organization_id', v_sponsor.organization_id, 'origin', 'admin'));
end; $$;

revoke all on function public.admin_set_sponsor_banner(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_sponsor_banner(uuid, text) to authenticated;

create or replace function public.admin_set_sponsor_carousel_interval(p_organization_id uuid, p_interval_seconds integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  v_org := coalesce(p_organization_id, public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if coalesce(p_interval_seconds, 0) < 2 or coalesce(p_interval_seconds, 0) > 30 then
    raise exception 'Intervalo deve estar entre 2 e 30 segundos.';
  end if;
  update public.organizations set sponsor_carousel_interval_seconds = p_interval_seconds where id = v_org;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
    ('sponsor_carousel_interval_updated', 'organizations', v_org, null, jsonb_build_object('actor_user_id', v_actor, 'interval_seconds', p_interval_seconds));
end; $$;

revoke all on function public.admin_set_sponsor_carousel_interval(uuid, integer) from public, anon, authenticated;
grant execute on function public.admin_set_sponsor_carousel_interval(uuid, integer) to authenticated;

-- Busca candidatos a "vincular usuario" (mesmo padrao de
-- search_admin_ticket_owner_accounts): contas que ja compraram/participaram
-- de algum evento da organizacao, buscadas por nome ou e-mail, excluindo
-- quem ja esta vinculado a outro patrocinador.
create or replace function public.admin_search_sponsor_candidate_users(p_term text, p_organization_id uuid default null)
returns table(user_id uuid, full_name text, masked_email text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid; v_term text := trim(coalesce(p_term, ''));
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  v_org := coalesce(p_organization_id, public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if length(v_term) < 3 then raise exception 'Informe ao menos 3 caracteres para buscar.'; end if;

  return query
  with organization_accounts as (
    select o.user_id from public.orders o where o.organization_id = v_org and o.user_id is not null
    union
    select om.user_id from public.organization_members om where om.organization_id = v_org and om.is_active
  )
  select au.id, coalesce(nullif(trim(cp.full_name), ''), nullif(trim(au.raw_user_meta_data->>'full_name'), ''), 'Conta NEXORA'),
    case when position('@' in coalesce(au.email, '')) > 1 then left(au.email, 2) || '***@' || split_part(au.email, '@', 2) end
  from organization_accounts oa
  join auth.users au on au.id = oa.user_id
  left join public.customer_profiles cp on cp.user_id = au.id
  where not exists (select 1 from public.sponsors s where s.user_id = au.id)
    and (coalesce(cp.full_name, au.raw_user_meta_data->>'full_name', '') ilike '%' || v_term || '%' or coalesce(au.email, '') ilike '%' || v_term || '%')
  order by 2, au.id limit 20;
end; $$;

revoke all on function public.admin_search_sponsor_candidate_users(text, uuid) from public, anon, authenticated;
grant execute on function public.admin_search_sponsor_candidate_users(text, uuid) to authenticated;

-- ============================================================
-- 6. RPCs do proprio patrocinador (nunca aceitam sponsor_id do client --
--    sempre resolvem pelo auth.uid() do ator, e essa e a garantia real de
--    que "um patrocinador nunca altera o banner de outro").
-- ============================================================

create or replace function public.get_my_sponsor_profile()
returns table(sponsor_id uuid, organization_id uuid, organization_name text, name text, banner_url text, is_active boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.organization_id, o.name, s.name, s.banner_url, s.is_active
  from public.sponsors s
  join public.organizations o on o.id = s.organization_id
  where s.user_id = auth.uid();
$$;

revoke all on function public.get_my_sponsor_profile() from public, anon;
grant execute on function public.get_my_sponsor_profile() to authenticated;

create or replace function public.update_my_sponsor_banner(p_banner_url text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_sponsor public.sponsors%rowtype; v_banner_url text;
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  select * into v_sponsor from public.sponsors where user_id = v_actor for update;
  if not found then raise exception 'Nenhum patrocinador vinculado a esta conta.'; end if;
  v_banner_url := nullif(trim(coalesce(p_banner_url, '')), '');
  -- Mesma validacao de path de admin_set_sponsor_banner: um patrocinador so
  -- pode referenciar um objeto dentro da propria pasta no bucket
  -- sponsor-banners, nunca o banner de outro patrocinador.
  if v_banner_url is not null and position('/sponsor-banners/' || v_sponsor.id::text || '/' in v_banner_url) = 0 then
    raise exception 'URL de banner invalida para este patrocinador.';
  end if;
  update public.sponsors set banner_url = v_banner_url, updated_at = now() where id = v_sponsor.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
    ('sponsor_banner_updated', 'sponsors', v_sponsor.id, null, jsonb_build_object('actor_user_id', v_actor,
      'organization_id', v_sponsor.organization_id, 'origin', 'self_service'));
end; $$;

revoke all on function public.update_my_sponsor_banner(text) from public, anon, authenticated;
grant execute on function public.update_my_sponsor_banner(text) to authenticated;

-- ============================================================
-- 7. Leitura publica para a Home (carrossel de patrocinadores). O sistema
--    ainda opera como uma unica organizacao "principal" por instalacao (ver
--    get_featured_events_for_dashboard, que tambem nao filtra por
--    organizacao) -- esta funcao segue a mesma convencao pragmatica de hoje;
--    quando o NEXORA multi-tenant precisar filtrar por organizacao do
--    visitante, e uma extensao trivial desta unica funcao, sem tocar
--    schema/RLS/RPCs de escrita (que ja sao corretamente escopados).
-- ============================================================

create or replace function public.get_active_sponsors_for_home()
returns table(sponsor_id uuid, name text, banner_url text, sort_order integer, carousel_interval_seconds integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.name, s.banner_url, s.sort_order, o.sponsor_carousel_interval_seconds
  from public.sponsors s
  join public.organizations o on o.id = s.organization_id
  where s.is_active = true and s.banner_url is not null
  order by s.sort_order, s.name;
$$;

revoke all on function public.get_active_sponsors_for_home() from public, anon;
grant execute on function public.get_active_sponsors_for_home() to authenticated;

commit;
