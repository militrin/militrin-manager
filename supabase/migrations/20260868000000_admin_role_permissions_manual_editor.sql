-- Editor manual de permissoes por FUNCAO (nao por usuario -- esse ja existe
-- em /configuracoes/equipe/[userId], via upsert_admin_user_access). Reaproveita
-- 100% do RBAC existente (admin_roles/admin_permissions/admin_role_permissions/
-- admin_user_permission_overrides, resolve_user_permission) -- nenhuma tabela
-- ou logica de autorizacao paralela.
--
-- Precedencia (inalterada, ja garantida por resolve_user_permission): Owner
-- sempre true -> override 'deny' do usuario -> override 'allow' do usuario ->
-- admin_role_permissions da funcao do usuario -> false. Editar
-- admin_role_permissions aqui e exatamente o que resolve_user_permission ja
-- le ao vivo (sem cache), entao qualquer usuario "Herdar" de uma funcao
-- reflete a mudanca imediatamente; overrides individuais continuam com
-- precedencia total, sem nenhuma alteracao nessa funcao.
begin;

-- "Restaurar padrao do sistema": fonte segura e um snapshot do que
-- admin_role_permissions JA continha no momento em que este editor manual
-- passa a existir -- ou seja, o preset acumulado por todas as migrations de
-- feature anteriores (nunca houve um unico seed canonico; cada modulo grava
-- suas proprias permissoes/papeis ao longo do tempo). Congelado agora, uma
-- unica vez; nunca mais reescrito por nenhuma migration futura.
create table if not exists public.admin_role_permissions_system_default (
  role_id uuid not null references public.admin_roles(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

insert into public.admin_role_permissions_system_default (role_id, permission_id)
select role_id, permission_id from public.admin_role_permissions
on conflict do nothing;

comment on table public.admin_role_permissions_system_default is
  'Snapshot congelado (uma vez, nesta migration) do preset de admin_role_permissions no momento em que o editor manual de permissoes por funcao foi introduzido. Fonte de "Restaurar padrao do sistema" -- nunca atualizado depois.';

-- Leitura: todas as permissoes ativas, agrupadas por modulo, com o estado
-- atual (tem/nao tem) da FUNCAO e se esse estado bate com o padrao do
-- sistema (pra UI sinalizar o que foi customizado).
create or replace function public.list_admin_role_permissions(p_role_id uuid)
returns table(code text, module text, name text, description text, has_permission boolean, is_system_default boolean)
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;
  if not public.current_user_has_permission('team.view') then raise exception 'Sem permissao para visualizar permissoes de funcoes.'; end if;
  if not exists (select 1 from public.admin_roles where id = p_role_id) then raise exception 'Funcao nao encontrada.'; end if;

  return query
  select
    p.code, p.module, p.name, p.description,
    (arp.permission_id is not null) as has_permission,
    (def.permission_id is not null) as is_system_default
  from public.admin_permissions p
  left join public.admin_role_permissions arp on arp.permission_id = p.id and arp.role_id = p_role_id
  left join public.admin_role_permissions_system_default def on def.permission_id = p.id and def.role_id = p_role_id
  where p.is_active = true
  order by p.module asc, p.sort_order asc, p.code asc;
end; $$;

revoke all on function public.list_admin_role_permissions(uuid) from public;
grant execute on function public.list_admin_role_permissions(uuid) to authenticated, service_role;

-- Escrita em lote: substitui o conjunto de permissoes da funcao pelo
-- conjunto exato informado (nao e um diff de allow/deny como overrides
-- individuais -- uma funcao so "tem" ou "nao tem" cada permissao).
--
-- Protecoes (todas no BACKEND, a UI e so conveniencia):
--   1) exige team.edit_permissions (ou Owner).
--   2) funcao 'owner' nunca e editavel por aqui -- ela ja e sempre true
--      incondicionalmente em resolve_user_permission, edita-la aqui so
--      criaria uma ilusao de controle que nao tem efeito nenhum.
--   3) quem nao e Owner nao pode conceder a uma funcao uma permissao que
--      ele mesmo nao possui (mesma logica ja usada por upsert_admin_user_access
--      pra usuario individual, aqui aplicada a funcao).
--   4) nunca permite salvar uma alteracao que deixaria ZERO usuarios ativos
--      com acesso pra administrar equipe/permissoes (nem Owner ativo, nem
--      ninguem com team.edit_permissions) -- checado DEPOIS de aplicar a
--      mudanca, na mesma transacao; se falhar, a excecao reverte tudo.
create or replace function public.upsert_admin_role_permissions(p_role_id uuid, p_permission_codes text[], p_reason text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = v_actor_user_id), 'system');
  v_actor_is_owner boolean := false;
  v_role_code text;
  v_role_name text;
  v_invalid_code text;
  v_before_codes text[] := array[]::text[];
  v_after_codes text[] := array[]::text[];
  v_added text[] := array[]::text[];
  v_removed text[] := array[]::text[];
  v_forbidden_grant text;
begin
  if v_actor_user_id is null then raise exception 'Usuario autenticado obrigatorio.'; end if;

  v_actor_is_owner := public.is_active_owner(v_actor_user_id);
  if not (v_actor_is_owner or public.current_user_has_permission('team.edit_permissions')) then
    raise exception 'Sem permissao para editar permissoes de funcoes.';
  end if;

  select ar.code, ar.name into v_role_code, v_role_name
  from public.admin_roles ar where ar.id = p_role_id and ar.is_active = true;
  if v_role_code is null then raise exception 'Funcao nao encontrada ou inativa.'; end if;
  if v_role_code = 'owner' then
    raise exception 'A funcao Owner sempre tem acesso total; as permissoes dela nao podem ser editadas.';
  end if;

  select code_input into v_invalid_code
  from unnest(coalesce(p_permission_codes, array[]::text[])) as code_input
  where not exists (select 1 from public.admin_permissions ap where ap.code = code_input and ap.is_active = true)
  limit 1;
  if v_invalid_code is not null then
    raise exception 'Permissao invalida ou inativa: %', v_invalid_code;
  end if;

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
  into v_before_codes
  from public.admin_role_permissions arp
  join public.admin_permissions ap on ap.id = arp.permission_id
  where arp.role_id = p_role_id;

  if not v_actor_is_owner then
    select code_input into v_forbidden_grant
    from unnest(coalesce(p_permission_codes, array[]::text[])) as code_input
    where code_input <> all (v_before_codes)
      and not public.resolve_user_permission(v_actor_user_id, code_input)
    limit 1;
    if v_forbidden_grant is not null then
      raise exception 'Voce nao pode conceder a uma funcao uma permissao que voce mesmo nao possui: %', v_forbidden_grant;
    end if;
  end if;

  delete from public.admin_role_permissions where role_id = p_role_id;

  insert into public.admin_role_permissions (role_id, permission_id)
  select p_role_id, ap.id
  from unnest(coalesce(p_permission_codes, array[]::text[])) as code_input
  join public.admin_permissions ap on ap.code = code_input and ap.is_active = true
  on conflict (role_id, permission_id) do nothing;

  if not exists (
    select 1 from public.admin_users au
    where au.is_active
      and (public.is_active_owner(au.user_id) or public.resolve_user_permission(au.user_id, 'team.edit_permissions'))
  ) then
    raise exception 'Esta alteracao deixaria nenhum usuario com permissao para administrar equipe/permissoes.';
  end if;

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
  into v_after_codes
  from public.admin_role_permissions arp
  join public.admin_permissions ap on ap.id = arp.permission_id
  where arp.role_id = p_role_id;

  select coalesce(array_agg(code order by code), array[]::text[]) into v_added
  from (select unnest(v_after_codes) except select unnest(v_before_codes)) t(code);

  select coalesce(array_agg(code order by code), array[]::text[]) into v_removed
  from (select unnest(v_before_codes) except select unnest(v_after_codes)) t(code);

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'admin_role_permissions_updated', 'admin_roles', p_role_id, null,
    jsonb_build_object(
      'actor_user_id', v_actor_user_id, 'actor_email', v_actor_email,
      'role_id', p_role_id, 'role_code', v_role_code, 'role_name', v_role_name,
      'added_permissions', coalesce(v_added, array[]::text[]),
      'removed_permissions', coalesce(v_removed, array[]::text[]),
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return jsonb_build_object(
    'success', true, 'role_id', p_role_id,
    'added_permissions', coalesce(v_added, array[]::text[]),
    'removed_permissions', coalesce(v_removed, array[]::text[])
  );
end; $$;

revoke all on function public.upsert_admin_role_permissions(uuid, text[], text) from public;
grant execute on function public.upsert_admin_role_permissions(uuid, text[], text) to authenticated, service_role;

-- "Restaurar padrao do sistema": so resolve o conjunto de codigos do
-- snapshot e delega 100% da escrita (e de TODAS as protecoes acima) pra
-- upsert_admin_role_permissions -- unica fonte de verdade de mutacao,
-- nenhuma logica de seguranca duplicada.
create or replace function public.restore_admin_role_permissions_default(p_role_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_codes text[];
begin
  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
  into v_codes
  from public.admin_role_permissions_system_default def
  join public.admin_permissions ap on ap.id = def.permission_id and ap.is_active = true
  where def.role_id = p_role_id;

  return public.upsert_admin_role_permissions(
    p_role_id, v_codes,
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Restaurado para o padrao do sistema')
  );
end; $$;

revoke all on function public.restore_admin_role_permissions_default(uuid, text) from public;
grant execute on function public.restore_admin_role_permissions_default(uuid, text) to authenticated, service_role;

commit;
