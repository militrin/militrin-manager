-- 024_rbac_and_owner_bootstrap.sql
-- RBAC definitivo + bootstrap seguro do Owner principal.

create extension if not exists pgcrypto;

create table if not exists public.admin_roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  module text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_role_permissions (
  role_id uuid not null references public.admin_roles(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role_id uuid references public.admin_roles(id),
  is_active boolean not null default true,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_user_permission_overrides (
  user_id uuid not null references auth.users(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  effect text not null check (effect in ('allow', 'deny')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, permission_id)
);

alter table if exists public.admin_roles
  add column if not exists code text,
  add column if not exists is_active boolean not null default true;

alter table if exists public.admin_permissions
  add column if not exists sort_order integer not null default 0,
  add column if not exists is_active boolean not null default true;

alter table if exists public.admin_users
  add column if not exists internal_note text,
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.admin_user_permission_overrides
  add column if not exists updated_at timestamptz not null default now();

update public.admin_roles
set code = case
  when lower(name) in ('owner') then 'owner'
  when lower(name) in ('administrator', 'administrador', 'admin') then 'administrator'
  when lower(name) in ('manager', 'gerente') then 'manager'
  when lower(name) in ('finance', 'financeiro') then 'finance'
  when lower(name) in ('checkin', 'check-in', 'check in') then 'checkin'
  when lower(name) in ('kit_delivery', 'entrega de kits', 'entrega de kit') then 'kit_delivery'
  when lower(name) in ('inventory', 'estoque') then 'inventory'
  when lower(name) in ('support', 'suporte') then 'support'
  when lower(name) in ('marketing') then 'marketing'
  when lower(name) in ('viewer', 'visualizacao') then 'viewer'
  else null
end
where code is null or btrim(code) = '';

update public.admin_roles
set code = lower(regexp_replace(coalesce(name, ''), '[^a-z0-9]+', '_', 'g'))
where code is null or btrim(code) = '';

with ranked as (
  select id, code, row_number() over (partition by code order by created_at, id) as rn
  from public.admin_roles
)
update public.admin_roles ar
set code = ar.code || '_' || substr(ar.id::text, 1, 8)
from ranked r
where ar.id = r.id
  and r.rn > 1;

alter table if exists public.admin_roles
  alter column code set not null,
  alter column name set not null,
  alter column is_system set default false,
  alter column is_active set default true,
  alter column updated_at set default now();

create unique index if not exists ux_admin_roles_code on public.admin_roles(code);
create unique index if not exists ux_admin_roles_name on public.admin_roles(name);
create index if not exists idx_admin_permissions_module_sort on public.admin_permissions(module, sort_order, code);
create index if not exists idx_admin_users_role_active on public.admin_users(role_id, is_active);
create index if not exists idx_admin_overrides_user_effect on public.admin_user_permission_overrides(user_id, effect);

create or replace function public.touch_admin_roles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.touch_admin_users_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.touch_admin_overrides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_admin_roles_touch_updated_at on public.admin_roles;
create trigger trg_admin_roles_touch_updated_at
before update on public.admin_roles
for each row
execute function public.touch_admin_roles_updated_at();

drop trigger if exists trg_admin_users_touch_updated_at on public.admin_users;
create trigger trg_admin_users_touch_updated_at
before update on public.admin_users
for each row
execute function public.touch_admin_users_updated_at();

drop trigger if exists trg_admin_overrides_touch_updated_at on public.admin_user_permission_overrides;
create trigger trg_admin_overrides_touch_updated_at
before update on public.admin_user_permission_overrides
for each row
execute function public.touch_admin_overrides_updated_at();

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('dashboard.view', 'Ver dashboard', 'Visualiza o dashboard administrativo', 'dashboard', 10, true),

  ('participants.view', 'Ver participantes', 'Visualiza listagem de participantes', 'participants', 10, true),
  ('participants.create', 'Criar participantes', 'Cria inscricoes/participantes', 'participants', 20, true),
  ('participants.edit_basic', 'Editar dados basicos', 'Altera dados nao sensiveis', 'participants', 30, true),
  ('participants.edit_sensitive', 'Editar dados sensiveis', 'Altera dados sensiveis dos participantes', 'participants', 40, true),
  ('participants.cancel', 'Cancelar participante', 'Cancela inscricoes de participantes', 'participants', 50, true),
  ('participants.export', 'Exportar participantes', 'Exporta listagens de participantes', 'participants', 60, true),

  ('orders.view', 'Ver pedidos', 'Visualiza pedidos e status', 'orders', 10, true),
  ('orders.edit', 'Editar pedidos', 'Edita dados de pedidos', 'orders', 20, true),
  ('orders.cancel', 'Cancelar pedidos', 'Cancela pedidos', 'orders', 30, true),
  ('orders.resend_ticket', 'Reenviar ingresso', 'Reenvia ticket/ingresso por e-mail', 'orders', 40, true),

  ('finance.view', 'Ver financeiro', 'Visualiza modulo financeiro', 'finance', 10, true),
  ('finance.view_amounts', 'Ver valores financeiros', 'Visualiza valores monetarios', 'finance', 20, true),
  ('finance.confirm_payment', 'Confirmar pagamento', 'Confirma pagamento manualmente', 'finance', 30, true),
  ('finance.refund', 'Efetuar estorno', 'Executa estorno de pagamento', 'finance', 40, true),
  ('finance.export', 'Exportar financeiro', 'Exporta relatorios financeiros', 'finance', 50, true),

  ('inventory.view', 'Ver estoque', 'Visualiza estoque', 'inventory', 10, true),
  ('inventory.adjust', 'Ajustar estoque', 'Ajusta quantidades de estoque', 'inventory', 20, true),
  ('inventory.change_participant_shirt', 'Trocar camiseta do participante', 'Altera camiseta vinculada ao participante', 'inventory', 30, true),
  ('inventory.view_history', 'Ver historico de estoque', 'Visualiza historico de movimentacoes do estoque', 'inventory', 40, true),

  ('kits.view', 'Ver kits', 'Visualiza status de kits', 'kits', 10, true),
  ('kits.deliver', 'Entregar kits', 'Registra entrega de kits', 'kits', 20, true),
  ('kits.undo_delivery', 'Desfazer entrega', 'Desfaz entrega de kits', 'kits', 30, true),
  ('kits.replace_item', 'Substituir item de kit', 'Substitui item em kit', 'kits', 40, true),
  ('kits.view_history', 'Ver historico de kits', 'Visualiza historico de kits', 'kits', 50, true),

  ('checkin.view', 'Ver check-in', 'Visualiza painel de check-in', 'checkin', 10, true),
  ('checkin.scan', 'Realizar check-in', 'Realiza leitura/registro de check-in', 'checkin', 20, true),
  ('checkin.undo', 'Desfazer check-in', 'Desfaz check-in registrado', 'checkin', 30, true),
  ('checkin.view_history', 'Ver historico de check-in', 'Visualiza historico de check-in', 'checkin', 40, true),

  ('events.view', 'Ver eventos', 'Visualiza eventos', 'events', 10, true),
  ('events.create', 'Criar eventos', 'Cria eventos', 'events', 20, true),
  ('events.edit', 'Editar eventos', 'Edita eventos', 'events', 30, true),
  ('events.publish', 'Publicar eventos', 'Publica eventos', 'events', 40, true),
  ('events.archive', 'Arquivar eventos', 'Arquiva eventos', 'events', 50, true),

  ('batches.view', 'Ver lotes', 'Visualiza lotes', 'batches', 10, true),
  ('batches.create', 'Criar lotes', 'Cria lotes', 'batches', 20, true),
  ('batches.edit', 'Editar lotes', 'Edita lotes', 'batches', 30, true),
  ('batches.activate', 'Ativar lotes', 'Ativa lotes', 'batches', 40, true),
  ('batches.delete', 'Excluir lotes', 'Exclui lotes', 'batches', 50, true),

  ('categories.view', 'Ver categorias', 'Visualiza categorias', 'categories', 10, true),
  ('categories.create', 'Criar categorias', 'Cria categorias', 'categories', 20, true),
  ('categories.edit', 'Editar categorias', 'Edita categorias', 'categories', 30, true),
  ('categories.delete', 'Excluir categorias', 'Exclui categorias', 'categories', 40, true),

  ('coupons.view', 'Ver cupons', 'Visualiza cupons', 'coupons', 10, true),
  ('coupons.create', 'Criar cupons', 'Cria cupons', 'coupons', 20, true),
  ('coupons.edit', 'Editar cupons', 'Edita cupons', 'coupons', 30, true),
  ('coupons.disable', 'Desativar cupons', 'Desativa cupons', 'coupons', 40, true),
  ('coupons.view_usage', 'Ver uso de cupons', 'Visualiza uso de cupons', 'coupons', 50, true),

  ('photos.view_admin', 'Ver fotos admin', 'Visualiza fotos no modulo admin', 'photos', 10, true),
  ('photos.upload', 'Enviar fotos', 'Realiza upload de fotos', 'photos', 20, true),
  ('photos.publish', 'Publicar fotos', 'Publica fotos', 'photos', 30, true),
  ('photos.delete', 'Excluir fotos', 'Exclui fotos', 'photos', 40, true),

  ('imports.view', 'Ver importacoes', 'Visualiza importacoes', 'imports', 10, true),
  ('imports.create', 'Criar importacao', 'Cria importacoes', 'imports', 20, true),
  ('imports.review', 'Revisar importacao', 'Revisa importacoes', 'imports', 30, true),
  ('imports.rollback', 'Rollback de importacao', 'Reverte importacao', 'imports', 40, true),

  ('reports.view', 'Ver relatorios', 'Visualiza relatorios', 'reports', 10, true),
  ('reports.export', 'Exportar relatorios', 'Exporta relatorios', 'reports', 20, true),

  ('team.view', 'Ver equipe', 'Visualiza equipe administrativa', 'team', 10, true),
  ('team.invite', 'Convidar equipe', 'Convida usuarios para equipe admin', 'team', 20, true),
  ('team.edit_role', 'Editar funcao da equipe', 'Edita funcao base de usuarios da equipe', 'team', 30, true),
  ('team.edit_permissions', 'Editar permissoes da equipe', 'Edita overrides por usuario', 'team', 40, true),
  ('team.disable_user', 'Desativar usuario da equipe', 'Desativa usuario administrativo', 'team', 50, true),

  ('audit.view', 'Ver auditoria', 'Visualiza trilha de auditoria', 'security', 10, true),
  ('settings.manage', 'Gerenciar configuracoes', 'Gerencia configuracoes administrativas', 'settings', 10, true)
on conflict (code) do update
set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

insert into public.admin_roles (code, name, description, is_system, is_active)
values
  ('owner', 'Owner', 'Acesso total. Papel sistemico.', true, true),
  ('administrator', 'Administrator', 'Acesso administrativo amplo.', true, true),
  ('manager', 'Manager', 'Gestao operacional ampla.', true, true),
  ('finance', 'Finance', 'Operacoes financeiras e relatorios.', true, true),
  ('checkin', 'Check-in', 'Operacoes de check-in.', true, true),
  ('kit_delivery', 'Kit Delivery', 'Operacoes de entrega de kits.', true, true),
  ('inventory', 'Inventory', 'Gestao de estoque e camisetas.', true, true),
  ('support', 'Support', 'Atendimento e ajustes operacionais.', true, true),
  ('marketing', 'Marketing', 'Gestao de eventos e fotos.', true, true),
  ('viewer', 'Viewer', 'Perfil de visualizacao.', true, true)
on conflict (code) do update
set
  name = excluded.name,
  description = excluded.description,
  is_system = excluded.is_system,
  is_active = excluded.is_active;

with role_permissions(role_code, permission_code) as (
  values
    ('finance', 'dashboard.view'),
    ('finance', 'orders.view'),
    ('finance', 'finance.view'),
    ('finance', 'finance.view_amounts'),
    ('finance', 'finance.confirm_payment'),
    ('finance', 'finance.refund'),
    ('finance', 'finance.export'),
    ('finance', 'reports.view'),
    ('finance', 'reports.export'),

    ('checkin', 'participants.view'),
    ('checkin', 'checkin.view'),
    ('checkin', 'checkin.scan'),
    ('checkin', 'checkin.view_history'),

    ('kit_delivery', 'participants.view'),
    ('kit_delivery', 'kits.view'),
    ('kit_delivery', 'kits.deliver'),
    ('kit_delivery', 'kits.view_history'),

    ('inventory', 'participants.view'),
    ('inventory', 'inventory.view'),
    ('inventory', 'inventory.adjust'),
    ('inventory', 'inventory.change_participant_shirt'),
    ('inventory', 'inventory.view_history'),
    ('inventory', 'kits.view'),

    ('support', 'participants.view'),
    ('support', 'participants.edit_basic'),
    ('support', 'orders.view'),
    ('support', 'orders.resend_ticket'),

    ('marketing', 'events.view'),
    ('marketing', 'photos.view_admin'),
    ('marketing', 'photos.upload'),
    ('marketing', 'photos.publish'),
    ('marketing', 'photos.delete'),

    ('viewer', 'dashboard.view'),
    ('viewer', 'participants.view'),
    ('viewer', 'orders.view'),

    ('manager', 'dashboard.view'),
    ('manager', 'participants.view'),
    ('manager', 'participants.create'),
    ('manager', 'participants.edit_basic'),
    ('manager', 'participants.cancel'),
    ('manager', 'participants.export'),
    ('manager', 'orders.view'),
    ('manager', 'orders.edit'),
    ('manager', 'orders.cancel'),
    ('manager', 'orders.resend_ticket'),
    ('manager', 'events.view'),
    ('manager', 'events.create'),
    ('manager', 'events.edit'),
    ('manager', 'events.publish'),
    ('manager', 'batches.view'),
    ('manager', 'batches.create'),
    ('manager', 'batches.edit'),
    ('manager', 'batches.activate'),
    ('manager', 'categories.view'),
    ('manager', 'categories.create'),
    ('manager', 'categories.edit'),
    ('manager', 'coupons.view'),
    ('manager', 'coupons.create'),
    ('manager', 'coupons.edit'),
    ('manager', 'coupons.view_usage'),
    ('manager', 'inventory.view'),
    ('manager', 'inventory.view_history'),
    ('manager', 'kits.view'),
    ('manager', 'checkin.view'),
    ('manager', 'imports.view'),
    ('manager', 'reports.view'),
    ('manager', 'reports.export')
), system_roles as (
  select id, code
  from public.admin_roles
  where code in ('owner', 'administrator', 'manager', 'finance', 'checkin', 'kit_delivery', 'inventory', 'support', 'marketing', 'viewer')
), selected_map as (
  select sr.id as role_id, ap.id as permission_id
  from role_permissions rp
  join system_roles sr on sr.code = rp.role_code
  join public.admin_permissions ap on ap.code = rp.permission_code and ap.is_active = true
), all_admin_map as (
  select sr.id as role_id, ap.id as permission_id
  from system_roles sr
  join public.admin_permissions ap on ap.is_active = true
  where sr.code in ('owner', 'administrator')
), desired as (
  select distinct role_id, permission_id from selected_map
  union
  select distinct role_id, permission_id from all_admin_map
)
insert into public.admin_role_permissions (role_id, permission_id)
select d.role_id, d.permission_id
from desired d
on conflict (role_id, permission_id) do nothing;

create or replace function public.is_active_owner(
  p_user_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.admin_users au
    join public.admin_roles ar on ar.id = au.role_id
    where au.user_id = p_user_id
      and au.is_active = true
      and ar.is_active = true
      and ar.code = 'owner'
  );
$$;

create or replace function public.resolve_user_permission(
  p_user_id uuid,
  p_permission_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role_id uuid;
  v_is_active boolean := false;
  v_is_owner boolean := false;
  v_permission_id uuid;
  v_has_deny boolean := false;
  v_has_allow boolean := false;
  v_has_role_permission boolean := false;
begin
  if p_user_id is null then
    return false;
  end if;

  if p_permission_code is null or btrim(p_permission_code) = '' then
    return false;
  end if;

  select au.role_id, au.is_active
    into v_role_id, v_is_active
  from public.admin_users au
  where au.user_id = p_user_id;

  if not coalesce(v_is_active, false) then
    return false;
  end if;

  select exists (
    select 1
    from public.admin_roles ar
    where ar.id = v_role_id
      and ar.is_active = true
      and ar.code = 'owner'
  ) into v_is_owner;

  if v_is_owner then
    return true;
  end if;

  select ap.id
    into v_permission_id
  from public.admin_permissions ap
  where ap.code = p_permission_code
    and ap.is_active = true
  limit 1;

  if v_permission_id is null then
    return false;
  end if;

  select exists (
    select 1
    from public.admin_user_permission_overrides uo
    where uo.user_id = p_user_id
      and uo.permission_id = v_permission_id
      and uo.effect = 'deny'
  ) into v_has_deny;

  if v_has_deny then
    return false;
  end if;

  select exists (
    select 1
    from public.admin_user_permission_overrides uo
    where uo.user_id = p_user_id
      and uo.permission_id = v_permission_id
      and uo.effect = 'allow'
  ) into v_has_allow;

  if v_has_allow then
    return true;
  end if;

  select exists (
    select 1
    from public.admin_role_permissions arp
    join public.admin_roles ar on ar.id = arp.role_id and ar.is_active = true
    where arp.role_id = v_role_id
      and arp.permission_id = v_permission_id
  ) into v_has_role_permission;

  return v_has_role_permission;
end;
$$;

create or replace function public.user_has_permission(
  p_user_id uuid,
  p_permission_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_is_owner boolean := false;
  v_actor_can_edit_permissions boolean := false;
begin
  if v_actor_user_id is null then
    return false;
  end if;

  if p_user_id is null then
    return false;
  end if;

  if v_actor_user_id <> p_user_id then
    v_actor_is_owner := public.is_active_owner(v_actor_user_id);
    v_actor_can_edit_permissions := public.resolve_user_permission(v_actor_user_id, 'team.edit_permissions');
    if not v_actor_is_owner and not v_actor_can_edit_permissions then
      return false;
    end if;
  end if;

  return public.resolve_user_permission(p_user_id, p_permission_code);
end;
$$;

create or replace function public.current_user_has_permission(
  p_permission_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
begin
  if v_actor_user_id is null then
    return false;
  end if;

  return public.resolve_user_permission(v_actor_user_id, p_permission_code);
end;
$$;

create or replace function public.list_admin_roles()
returns table (
  id uuid,
  name text,
  description text,
  is_active boolean,
  is_system boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar funcoes.';
  end if;

  return query
  select ar.id, ar.name, ar.description, ar.is_active, ar.is_system
  from public.admin_roles ar
  where ar.is_active = true
  order by case when ar.code = 'owner' then 0 else 1 end, ar.name;
end;
$$;

create or replace function public.list_override_state_for_user(
  p_user_id uuid
)
returns table (
  permission_code text,
  effect text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar overrides.';
  end if;

  return query
  select p.code, uo.effect
  from public.admin_user_permission_overrides uo
  join public.admin_permissions p on p.id = uo.permission_id
  where uo.user_id = p_user_id
  order by p.module, p.sort_order, p.code;
end;
$$;

create or replace function public.list_user_effective_permissions(
  p_user_id uuid
)
returns table (
  code text,
  module text,
  name text,
  state text,
  origin text,
  is_effective boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_target_role_id uuid;
  v_target_active boolean := false;
  v_target_is_owner boolean := false;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if p_user_id is null then
    raise exception 'Usuario alvo obrigatorio.';
  end if;

  if v_actor_user_id <> p_user_id and not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar permissoes deste usuario.';
  end if;

  select au.role_id, au.is_active
    into v_target_role_id, v_target_active
  from public.admin_users au
  where au.user_id = p_user_id;

  v_target_is_owner := public.is_active_owner(p_user_id);

  return query
  with role_permissions as (
    select arp.permission_id
    from public.admin_role_permissions arp
    where arp.role_id = v_target_role_id
  ), overrides as (
    select uo.permission_id, uo.effect
    from public.admin_user_permission_overrides uo
    where uo.user_id = p_user_id
  )
  select
    p.code,
    p.module,
    p.name,
    case
      when o.effect = 'allow' then 'allow'
      when o.effect = 'deny' then 'deny'
      else 'inherit'
    end as state,
    case
      when coalesce(v_target_active, false) = false then 'inactive_user'
      when v_target_is_owner then 'owner'
      when o.effect = 'deny' then 'denied_individual'
      when o.effect = 'allow' then 'allowed_individual'
      when rp.permission_id is not null then 'inherited_role'
      else 'no_access'
    end as origin,
    case
      when coalesce(v_target_active, false) = false then false
      when v_target_is_owner then true
      when o.effect = 'deny' then false
      when o.effect = 'allow' then true
      when rp.permission_id is not null then true
      else false
    end as is_effective
  from public.admin_permissions p
  left join role_permissions rp on rp.permission_id = p.id
  left join overrides o on o.permission_id = p.id
  where p.is_active = true
  order by p.module asc, p.sort_order asc, p.code asc;
end;
$$;

create or replace function public.list_admin_team(
  p_search text default null,
  p_role_name text default null,
  p_status text default null
)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role_name text,
  is_active boolean,
  effective_permission_count integer,
  last_access_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_search text := lower(trim(coalesce(p_search, '')));
  v_role_filter text := lower(trim(coalesce(p_role_name, '')));
  v_status_filter text := lower(trim(coalesce(p_status, '')));
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar equipe.';
  end if;

  return query
  with base as (
    select
      u.id as user_id,
      coalesce(nullif(trim(cp.full_name), ''), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)) as full_name,
      lower(u.email) as email,
      ar.name as role_name,
      coalesce(au.is_active, false) as is_active,
      u.last_sign_in_at as last_access_at
    from auth.users u
    left join public.admin_users au on au.user_id = u.id
    left join public.admin_roles ar on ar.id = au.role_id
    left join public.customer_profiles cp on cp.user_id = u.id
  )
  select
    b.user_id,
    b.full_name,
    b.email,
    b.role_name,
    b.is_active,
    (
      select count(*)::integer
      from public.admin_permissions p
      where p.is_active = true
        and public.resolve_user_permission(b.user_id, p.code)
    ) as effective_permission_count,
    b.last_access_at
  from base b
  where (
      v_search = ''
      or lower(coalesce(b.full_name, '')) like '%' || v_search || '%'
      or lower(coalesce(b.email, '')) like '%' || v_search || '%'
    )
    and (
      v_role_filter = ''
      or lower(coalesce(b.role_name, '')) = v_role_filter
    )
    and (
      v_status_filter = ''
      or (v_status_filter = 'active' and b.is_active = true)
      or (v_status_filter = 'inactive' and b.is_active = false)
    )
  order by b.full_name nulls last, b.email;
end;
$$;

create or replace function public.get_admin_user_profile(
  p_user_id uuid
)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role_id uuid,
  role_name text,
  is_active boolean,
  last_access_at timestamptz,
  internal_note text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar perfil administrativo.';
  end if;

  return query
  select
    u.id as user_id,
    coalesce(nullif(trim(cp.full_name), ''), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)) as full_name,
    lower(u.email) as email,
    au.role_id,
    ar.name as role_name,
    coalesce(au.is_active, false) as is_active,
    u.last_sign_in_at,
    au.internal_note
  from auth.users u
  left join public.admin_users au on au.user_id = u.id
  left join public.admin_roles ar on ar.id = au.role_id
  left join public.customer_profiles cp on cp.user_id = u.id
  where u.id = p_user_id;
end;
$$;

create or replace function public.upsert_admin_user_access(
  p_target_user_id uuid,
  p_role_id uuid,
  p_is_active boolean default true,
  p_internal_note text default null,
  p_overrides jsonb default '[]'::jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_email text := coalesce((select lower(email) from auth.users where id = v_actor_user_id), 'system');
  v_actor_is_owner boolean := false;
  v_actor_can_edit_permissions boolean := false;
  v_actor_can_disable_user boolean := false;
  v_target_exists boolean := false;
  v_target_before_is_owner boolean := false;
  v_target_after_is_owner boolean := false;
  v_target_before_role_id uuid;
  v_target_before_active boolean := false;
  v_target_before_note text;
  v_role_code text;
  v_before_effective text[] := array[]::text[];
  v_after_effective text[] := array[]::text[];
  v_added text[] := array[]::text[];
  v_removed text[] := array[]::text[];
  v_invalid_override_count integer := 0;
  v_forbidden_grant text;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if p_target_user_id is null then
    raise exception 'Usuario alvo obrigatorio.';
  end if;

  v_actor_is_owner := public.is_active_owner(v_actor_user_id);
  v_actor_can_edit_permissions := v_actor_is_owner or public.resolve_user_permission(v_actor_user_id, 'team.edit_permissions');
  v_actor_can_disable_user := v_actor_is_owner or public.resolve_user_permission(v_actor_user_id, 'team.disable_user');

  if not v_actor_can_edit_permissions then
    raise exception 'Sem permissao para editar acessos da equipe.';
  end if;

  select exists (select 1 from auth.users u where u.id = p_target_user_id)
    into v_target_exists;

  if not v_target_exists then
    raise exception 'Usuario alvo nao encontrado no Auth.';
  end if;

  select au.role_id, au.is_active, au.internal_note
    into v_target_before_role_id, v_target_before_active, v_target_before_note
  from public.admin_users au
  where au.user_id = p_target_user_id;

  v_target_before_is_owner := public.is_active_owner(p_target_user_id);

  if p_role_id is not null then
    select ar.code
      into v_role_code
    from public.admin_roles ar
    where ar.id = p_role_id
      and ar.is_active = true
    limit 1;

    if v_role_code is null then
      raise exception 'Funcao selecionada nao existe ou esta inativa.';
    end if;
  else
    v_role_code := null;
  end if;

  if v_target_before_is_owner and not v_actor_is_owner then
    raise exception 'Somente Owner pode editar outro Owner.';
  end if;

  if v_role_code = 'owner' and not v_actor_is_owner then
    raise exception 'Somente Owner pode promover usuario para Owner.';
  end if;

  if coalesce(p_is_active, true) = false and not v_actor_can_disable_user then
    raise exception 'Sem permissao para desativar usuario da equipe.';
  end if;

  select count(*)
    into v_invalid_override_count
  from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
  left join public.admin_permissions ap
    on ap.code = trim(coalesce(item ->> 'permission_code', ''))
   and ap.is_active = true
  where trim(coalesce(item ->> 'permission_code', '')) = ''
     or trim(coalesce(item ->> 'effect', '')) not in ('allow', 'deny')
     or ap.id is null;

  if v_invalid_override_count > 0 then
    raise exception 'Overrides invalidos: use permission_code valido e effect em allow/deny.';
  end if;

  if not v_actor_is_owner then
    with role_codes as (
      select p.code
      from public.admin_role_permissions arp
      join public.admin_permissions p on p.id = arp.permission_id
      where arp.role_id = p_role_id
        and p.is_active = true
    ), override_codes as (
      select
        trim(coalesce(item ->> 'permission_code', '')) as code,
        trim(coalesce(item ->> 'effect', '')) as effect
      from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
    ), denied as (
      select code from override_codes where effect = 'deny'
    ), allowed as (
      select code from override_codes where effect = 'allow'
    ), desired as (
      select code from role_codes
      union
      select code from allowed
      except
      select code from denied
    )
    select d.code
      into v_forbidden_grant
    from desired d
    where not public.resolve_user_permission(v_actor_user_id, d.code)
    limit 1;

    if v_forbidden_grant is not null then
      raise exception 'Voce nao pode conceder permissao que nao possui: %', v_forbidden_grant;
    end if;
  end if;

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
    into v_before_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  insert into public.admin_users (user_id, role_id, is_active, internal_note)
  values (
    p_target_user_id,
    p_role_id,
    coalesce(p_is_active, true),
    nullif(trim(coalesce(p_internal_note, '')), '')
  )
  on conflict (user_id)
  do update set
    role_id = excluded.role_id,
    is_active = excluded.is_active,
    internal_note = excluded.internal_note,
    updated_at = now();

  delete from public.admin_user_permission_overrides
  where user_id = p_target_user_id;

  insert into public.admin_user_permission_overrides (user_id, permission_id, effect)
  select
    p_target_user_id,
    ap.id,
    trim(item ->> 'effect')
  from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
  join public.admin_permissions ap
    on ap.code = trim(item ->> 'permission_code')
   and ap.is_active = true
  on conflict (user_id, permission_id)
  do update set
    effect = excluded.effect,
    updated_at = now();

  v_target_after_is_owner := public.is_active_owner(p_target_user_id);

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
    into v_after_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  select coalesce(array_agg(code order by code), array[]::text[])
    into v_added
  from (
    select unnest(v_after_effective)
    except
    select unnest(v_before_effective)
  ) t(code);

  select coalesce(array_agg(code order by code), array[]::text[])
    into v_removed
  from (
    select unnest(v_before_effective)
    except
    select unnest(v_after_effective)
  ) t(code);

  if to_regclass('public.audit_logs') is not null then
    insert into public.audit_logs (
      actor,
      action,
      entity_type,
      entity_id,
      event_id,
      details
    ) values (
      v_actor_email,
      'admin_access_updated',
      'admin_users',
      p_target_user_id,
      null,
      jsonb_build_object(
        'target_user_id', p_target_user_id,
        'target_before_role_id', v_target_before_role_id,
        'target_after_role_id', p_role_id,
        'target_before_is_owner', v_target_before_is_owner,
        'target_after_is_owner', v_target_after_is_owner,
        'status_before', coalesce(v_target_before_active, false),
        'status_after', coalesce(p_is_active, true),
        'added_permissions', coalesce(v_added, array[]::text[]),
        'removed_permissions', coalesce(v_removed, array[]::text[]),
        'reason', nullif(trim(coalesce(p_reason, '')), '')
      )
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'target_user_id', p_target_user_id,
    'added_permissions', coalesce(v_added, array[]::text[]),
    'removed_permissions', coalesce(v_removed, array[]::text[])
  );
end;
$$;

create or replace function public.prevent_owner_role_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.code = 'owner' then
      raise exception 'A funcao Owner nao pode ser removida.';
    end if;
    return old;
  end if;

  if old.code = 'owner' and coalesce(new.is_active, true) = false then
    raise exception 'A funcao Owner nao pode ser desativada.';
  end if;

  return new;
end;
$$;

create or replace function public.prevent_last_owner_admin_user_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_is_owner_active boolean := false;
  v_new_is_owner_active boolean := false;
  v_remaining_active_owner_count integer := 0;
begin
  if tg_op = 'DELETE' then
    select exists (
      select 1
      from public.admin_roles ar
      where ar.id = old.role_id
        and ar.code = 'owner'
        and ar.is_active = true
    ) and coalesce(old.is_active, false)
    into v_old_is_owner_active;

    if v_old_is_owner_active then
      select count(*)::integer
        into v_remaining_active_owner_count
      from public.admin_users au
      join public.admin_roles ar on ar.id = au.role_id
      where au.user_id <> old.user_id
        and au.is_active = true
        and ar.is_active = true
        and ar.code = 'owner';

      if v_remaining_active_owner_count = 0 then
        raise exception 'Nao e permitido remover o ultimo Owner ativo.';
      end if;
    end if;

    return old;
  end if;

  select exists (
    select 1
    from public.admin_roles ar
    where ar.id = old.role_id
      and ar.code = 'owner'
      and ar.is_active = true
  ) and coalesce(old.is_active, false)
  into v_old_is_owner_active;

  select exists (
    select 1
    from public.admin_roles ar
    where ar.id = new.role_id
      and ar.code = 'owner'
      and ar.is_active = true
  ) and coalesce(new.is_active, false)
  into v_new_is_owner_active;

  if v_old_is_owner_active and not v_new_is_owner_active then
    select count(*)::integer
      into v_remaining_active_owner_count
    from public.admin_users au
    join public.admin_roles ar on ar.id = au.role_id
    where au.user_id <> old.user_id
      and au.is_active = true
      and ar.is_active = true
      and ar.code = 'owner';

    if v_remaining_active_owner_count = 0 then
      raise exception 'Nao e permitido desativar ou rebaixar o ultimo Owner ativo.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_owner_role_mutation on public.admin_roles;
create trigger trg_prevent_owner_role_mutation
before update or delete on public.admin_roles
for each row
execute function public.prevent_owner_role_mutation();

drop trigger if exists trg_prevent_last_owner_admin_user_mutation on public.admin_users;
create trigger trg_prevent_last_owner_admin_user_mutation
before update or delete on public.admin_users
for each row
execute function public.prevent_last_owner_admin_user_mutation();

do $$
declare
  v_owner_role_id uuid;
  v_owner_user_id uuid;
begin
  select id
    into v_owner_role_id
  from public.admin_roles
  where code = 'owner'
    and is_active = true
  limit 1;

  if v_owner_role_id is null then
    raise exception 'Bootstrap Owner falhou: funcao owner nao encontrada ou inativa.';
  end if;

  select id
    into v_owner_user_id
  from auth.users
  where lower(email) = 'h.dogui@gmail.com'
  order by created_at asc
  limit 1;

  if v_owner_user_id is null then
    raise exception 'Bootstrap Owner falhou: usuario auth.users com e-mail h.dogui@gmail.com nao encontrado.';
  end if;

  insert into public.admin_users (user_id, role_id, is_active, internal_note)
  values (
    v_owner_user_id,
    v_owner_role_id,
    true,
    'Bootstrap owner migration 024 - conta principal'
  )
  on conflict (user_id)
  do update set
    role_id = excluded.role_id,
    is_active = true,
    internal_note = coalesce(excluded.internal_note, public.admin_users.internal_note),
    updated_at = now();
end
$$;

alter table public.admin_roles enable row level security;
alter table public.admin_permissions enable row level security;
alter table public.admin_role_permissions enable row level security;
alter table public.admin_users enable row level security;
alter table public.admin_user_permission_overrides enable row level security;

revoke all on table public.admin_roles from public, anon, authenticated;
revoke all on table public.admin_permissions from public, anon, authenticated;
revoke all on table public.admin_role_permissions from public, anon, authenticated;
revoke all on table public.admin_users from public, anon, authenticated;
revoke all on table public.admin_user_permission_overrides from public, anon, authenticated;

revoke all on function public.is_active_owner(uuid) from public, anon, authenticated;
revoke all on function public.resolve_user_permission(uuid, text) from public, anon, authenticated;
revoke all on function public.user_has_permission(uuid, text) from public, anon, authenticated;
revoke all on function public.current_user_has_permission(text) from public, anon, authenticated;
revoke all on function public.list_user_effective_permissions(uuid) from public, anon, authenticated;
revoke all on function public.list_admin_team(text, text, text) from public, anon, authenticated;
revoke all on function public.get_admin_user_profile(uuid) from public, anon, authenticated;
revoke all on function public.list_admin_roles() from public, anon, authenticated;
revoke all on function public.list_override_state_for_user(uuid) from public, anon, authenticated;
revoke all on function public.upsert_admin_user_access(uuid, uuid, boolean, text, jsonb, text) from public, anon, authenticated;

grant execute on function public.user_has_permission(uuid, text) to authenticated;
grant execute on function public.current_user_has_permission(text) to authenticated;
grant execute on function public.list_user_effective_permissions(uuid) to authenticated;
grant execute on function public.list_admin_team(text, text, text) to authenticated;
grant execute on function public.get_admin_user_profile(uuid) to authenticated;
grant execute on function public.list_admin_roles() to authenticated;
grant execute on function public.list_override_state_for_user(uuid) to authenticated;
grant execute on function public.upsert_admin_user_access(uuid, uuid, boolean, text, jsonb, text) to authenticated;
