-- 020_admin_user_permissions.sql
-- RBAC administrativo hibrido: role base + overrides allow/deny por usuario.

create extension if not exists pgcrypto;

create table if not exists public.admin_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
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

drop trigger if exists trg_touch_admin_roles_updated_at on public.admin_roles;
create trigger trg_touch_admin_roles_updated_at
before update on public.admin_roles
for each row
execute function public.touch_admin_roles_updated_at();

drop trigger if exists trg_touch_admin_users_updated_at on public.admin_users;
create trigger trg_touch_admin_users_updated_at
before update on public.admin_users
for each row
execute function public.touch_admin_users_updated_at();

drop trigger if exists trg_touch_admin_overrides_updated_at on public.admin_user_permission_overrides;
create trigger trg_touch_admin_overrides_updated_at
before update on public.admin_user_permission_overrides
for each row
execute function public.touch_admin_overrides_updated_at();

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('dashboard.view', 'Ver dashboard', 'Visualiza indicadores gerais do painel', 'dashboard', 10, true),

  ('participants.view', 'Ver participantes', 'Visualiza listagem de participantes', 'participants', 10, true),
  ('participants.create', 'Criar participante', 'Cria inscricoes/participantes', 'participants', 20, true),
  ('participants.edit_basic', 'Editar dados basicos', 'Altera dados nao sensiveis', 'participants', 30, true),
  ('participants.edit_sensitive', 'Editar dados sensiveis', 'Altera cpf/email e dados criticos', 'participants', 40, true),
  ('participants.cancel', 'Cancelar participante', 'Cancela inscricao/participante', 'participants', 50, true),
  ('participants.export', 'Exportar participantes', 'Exporta listagem de participantes', 'participants', 60, true),

  ('orders.view', 'Ver pedidos', 'Visualiza pedidos', 'orders', 10, true),
  ('orders.edit', 'Editar pedidos', 'Atualiza dados operacionais de pedido', 'orders', 20, true),
  ('orders.cancel', 'Cancelar pedidos', 'Cancela pedidos quando permitido', 'orders', 30, true),
  ('orders.resend_ticket', 'Reenviar ingresso', 'Reenvia ingresso para participante', 'orders', 40, true),

  ('finance.view', 'Ver financeiro', 'Acessa modulo financeiro', 'finance', 10, true),
  ('finance.view_amounts', 'Ver valores', 'Visualiza valores monetarios detalhados', 'finance', 20, true),
  ('finance.confirm_payment', 'Confirmar pagamento', 'Confirma pagamento manual', 'finance', 30, true),
  ('finance.refund', 'Estornar pagamento', 'Executa estornos autorizados', 'finance', 40, true),
  ('finance.export', 'Exportar financeiro', 'Exporta relatorios financeiros', 'finance', 50, true),
  ('finance.manage_fees', 'Gerenciar taxas', 'Configura taxas operacionais', 'finance', 60, true),

  ('inventory.view', 'Ver estoque', 'Consulta estoque de camisetas', 'inventory', 10, true),
  ('inventory.add_order', 'Adicionar encomenda', 'Registra encomenda de estoque', 'inventory', 20, true),
  ('inventory.adjust', 'Ajustar estoque', 'Ajusta quantidades de estoque', 'inventory', 30, true),
  ('inventory.change_participant_shirt', 'Alterar camiseta do participante', 'Troca modelo/tamanho do participante', 'inventory', 40, true),
  ('inventory.view_history', 'Ver historico de estoque', 'Visualiza historico de movimentacoes', 'inventory', 50, true),

  ('kits.view', 'Ver kits', 'Visualiza modulo de retirada de kits', 'kits', 10, true),
  ('kits.deliver', 'Entregar kit', 'Registra entrega de kit', 'kits', 20, true),
  ('kits.undo_delivery', 'Desfazer entrega', 'Desfaz entrega de kit', 'kits', 30, true),
  ('kits.replace_item', 'Substituir item', 'Substitui item de kit', 'kits', 40, true),
  ('kits.view_history', 'Ver historico de kits', 'Visualiza historico de retiradas', 'kits', 50, true),

  ('checkin.view', 'Ver check-in', 'Visualiza modulo de check-in', 'checkin', 10, true),
  ('checkin.scan', 'Realizar check-in', 'Confirma entrada no evento', 'checkin', 20, true),
  ('checkin.undo', 'Desfazer check-in', 'Reverte check-in realizado', 'checkin', 30, true),
  ('checkin.view_history', 'Ver historico de check-in', 'Visualiza historico de entradas', 'checkin', 40, true),

  ('events.view', 'Ver eventos', 'Visualiza eventos', 'events', 10, true),
  ('events.create', 'Criar eventos', 'Cria novos eventos', 'events', 20, true),
  ('events.edit', 'Editar eventos', 'Edita configuracoes de eventos', 'events', 30, true),
  ('events.publish', 'Publicar eventos', 'Publica eventos', 'events', 40, true),
  ('events.archive', 'Arquivar eventos', 'Arquiva eventos', 'events', 50, true),

  ('batches.view', 'Ver lotes', 'Visualiza lotes de inscricao', 'batches', 10, true),
  ('batches.create', 'Criar lotes', 'Cria lotes', 'batches', 20, true),
  ('batches.edit', 'Editar lotes', 'Edita lotes', 'batches', 30, true),
  ('batches.activate', 'Ativar lotes', 'Ativa lotes', 'batches', 40, true),
  ('batches.delete', 'Excluir lotes', 'Remove lotes', 'batches', 50, true),

  ('categories.view', 'Ver categorias', 'Visualiza categorias', 'categories', 10, true),
  ('categories.create', 'Criar categorias', 'Cria categorias', 'categories', 20, true),
  ('categories.edit', 'Editar categorias', 'Edita categorias', 'categories', 30, true),
  ('categories.delete', 'Excluir categorias', 'Remove categorias', 'categories', 40, true),

  ('coupons.view', 'Ver cupons', 'Visualiza cupons', 'coupons', 10, true),
  ('coupons.create', 'Criar cupons', 'Cria cupons', 'coupons', 20, true),
  ('coupons.edit', 'Editar cupons', 'Edita cupons', 'coupons', 30, true),
  ('coupons.disable', 'Desabilitar cupons', 'Desabilita cupons', 'coupons', 40, true),
  ('coupons.view_usage', 'Ver uso de cupons', 'Visualiza uso dos cupons', 'coupons', 50, true),

  ('photos.view_admin', 'Ver fotos no admin', 'Visualiza fotos no painel', 'photos', 10, true),
  ('photos.upload', 'Enviar fotos', 'Realiza upload de fotos', 'photos', 20, true),
  ('photos.publish', 'Publicar fotos', 'Publica fotos', 'photos', 30, true),
  ('photos.delete', 'Excluir fotos', 'Exclui fotos', 'photos', 40, true),

  ('imports.view', 'Ver importacoes', 'Visualiza importacoes', 'imports', 10, true),
  ('imports.create', 'Criar importacoes', 'Cria importacoes', 'imports', 20, true),
  ('imports.review', 'Revisar importacoes', 'Revisa importacoes', 'imports', 30, true),
  ('imports.rollback', 'Desfazer importacoes', 'Desfaz importacoes', 'imports', 40, true),

  ('reports.view', 'Ver relatorios', 'Visualiza relatorios', 'reports', 10, true),
  ('reports.export', 'Exportar relatorios', 'Exporta relatorios', 'reports', 20, true),

  ('team.view', 'Ver equipe', 'Visualiza usuarios administrativos', 'team', 10, true),
  ('team.invite', 'Convidar equipe', 'Convida usuarios para equipe', 'team', 20, true),
  ('team.edit_role', 'Editar funcao da equipe', 'Altera funcao base da equipe', 'team', 30, true),
  ('team.edit_permissions', 'Editar permissoes da equipe', 'Altera permissoes individuais da equipe', 'team', 40, true),
  ('team.disable_user', 'Desativar usuario da equipe', 'Desativa usuario administrativo', 'team', 50, true),
  ('audit.view', 'Ver auditoria', 'Visualiza trilha de auditoria', 'security', 10, true),
  ('settings.manage', 'Gerenciar configuracoes', 'Gerencia configuracoes criticas do painel', 'settings', 10, true)
on conflict (code) do update
set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

insert into public.admin_roles (name, description, is_system, is_active)
values
  ('Owner', 'Acesso total ao painel e configuracoes criticas.', true, true),
  ('Administrador', 'Acesso amplo operacional e administrativo.', true, true),
  ('Gerente', 'Gestao operacional com restricoes financeiras pontuais.', true, true),
  ('Financeiro', 'Operacoes financeiras e relatorios.', true, true),
  ('Check-in', 'Operacoes de entrada no evento.', true, true),
  ('Entrega de kits', 'Operacoes de retirada e entrega de kits.', true, true),
  ('Estoque', 'Gestao de camisetas e estoque.', true, true),
  ('Suporte', 'Ajustes de cadastro e atendimento operacional.', true, true),
  ('Visualizacao', 'Perfil somente leitura para monitoramento.', true, true)
on conflict (name) do update
set
  description = excluded.description,
  is_system = excluded.is_system,
  is_active = excluded.is_active;

with role_permissions(role_name, permission_code) as (
  values
    ('Administrador', 'dashboard.view'),
    ('Administrador', 'participants.view'),
    ('Administrador', 'participants.create'),
    ('Administrador', 'participants.edit_basic'),
    ('Administrador', 'participants.edit_sensitive'),
    ('Administrador', 'participants.cancel'),
    ('Administrador', 'participants.export'),
    ('Administrador', 'orders.view'),
    ('Administrador', 'orders.edit'),
    ('Administrador', 'orders.cancel'),
    ('Administrador', 'orders.resend_ticket'),
    ('Administrador', 'finance.view'),
    ('Administrador', 'finance.view_amounts'),
    ('Administrador', 'finance.confirm_payment'),
    ('Administrador', 'finance.refund'),
    ('Administrador', 'finance.export'),
    ('Administrador', 'finance.manage_fees'),
    ('Administrador', 'inventory.view'),
    ('Administrador', 'inventory.add_order'),
    ('Administrador', 'inventory.adjust'),
    ('Administrador', 'inventory.change_participant_shirt'),
    ('Administrador', 'inventory.view_history'),
    ('Administrador', 'kits.view'),
    ('Administrador', 'kits.deliver'),
    ('Administrador', 'kits.undo_delivery'),
    ('Administrador', 'kits.replace_item'),
    ('Administrador', 'kits.view_history'),
    ('Administrador', 'checkin.view'),
    ('Administrador', 'checkin.scan'),
    ('Administrador', 'checkin.undo'),
    ('Administrador', 'checkin.view_history'),
    ('Administrador', 'events.view'),
    ('Administrador', 'events.create'),
    ('Administrador', 'events.edit'),
    ('Administrador', 'events.publish'),
    ('Administrador', 'events.archive'),
    ('Administrador', 'batches.view'),
    ('Administrador', 'batches.create'),
    ('Administrador', 'batches.edit'),
    ('Administrador', 'batches.activate'),
    ('Administrador', 'batches.delete'),
    ('Administrador', 'categories.view'),
    ('Administrador', 'categories.create'),
    ('Administrador', 'categories.edit'),
    ('Administrador', 'categories.delete'),
    ('Administrador', 'coupons.view'),
    ('Administrador', 'coupons.create'),
    ('Administrador', 'coupons.edit'),
    ('Administrador', 'coupons.disable'),
    ('Administrador', 'coupons.view_usage'),
    ('Administrador', 'photos.view_admin'),
    ('Administrador', 'photos.upload'),
    ('Administrador', 'photos.publish'),
    ('Administrador', 'photos.delete'),
    ('Administrador', 'imports.view'),
    ('Administrador', 'imports.create'),
    ('Administrador', 'imports.review'),
    ('Administrador', 'imports.rollback'),
    ('Administrador', 'reports.view'),
    ('Administrador', 'reports.export'),
    ('Administrador', 'team.view'),
    ('Administrador', 'team.invite'),
    ('Administrador', 'team.edit_role'),
    ('Administrador', 'team.edit_permissions'),
    ('Administrador', 'team.disable_user'),
    ('Administrador', 'audit.view'),
    ('Administrador', 'settings.manage'),

    ('Gerente', 'dashboard.view'),
    ('Gerente', 'participants.view'),
    ('Gerente', 'participants.create'),
    ('Gerente', 'participants.edit_basic'),
    ('Gerente', 'participants.cancel'),
    ('Gerente', 'participants.export'),
    ('Gerente', 'orders.view'),
    ('Gerente', 'orders.edit'),
    ('Gerente', 'orders.cancel'),
    ('Gerente', 'orders.resend_ticket'),
    ('Gerente', 'finance.view'),
    ('Gerente', 'finance.view_amounts'),
    ('Gerente', 'finance.confirm_payment'),
    ('Gerente', 'finance.export'),
    ('Gerente', 'inventory.view'),
    ('Gerente', 'inventory.change_participant_shirt'),
    ('Gerente', 'inventory.view_history'),
    ('Gerente', 'kits.view'),
    ('Gerente', 'kits.deliver'),
    ('Gerente', 'kits.view_history'),
    ('Gerente', 'checkin.view'),
    ('Gerente', 'checkin.scan'),
    ('Gerente', 'checkin.view_history'),
    ('Gerente', 'events.view'),
    ('Gerente', 'events.create'),
    ('Gerente', 'events.edit'),
    ('Gerente', 'events.publish'),
    ('Gerente', 'batches.view'),
    ('Gerente', 'batches.create'),
    ('Gerente', 'batches.edit'),
    ('Gerente', 'batches.activate'),
    ('Gerente', 'categories.view'),
    ('Gerente', 'categories.create'),
    ('Gerente', 'categories.edit'),
    ('Gerente', 'coupons.view'),
    ('Gerente', 'coupons.create'),
    ('Gerente', 'coupons.edit'),
    ('Gerente', 'coupons.view_usage'),
    ('Gerente', 'imports.view'),
    ('Gerente', 'imports.review'),
    ('Gerente', 'reports.view'),
    ('Gerente', 'reports.export'),

    ('Financeiro', 'dashboard.view'),
    ('Financeiro', 'participants.view'),
    ('Financeiro', 'participants.export'),
    ('Financeiro', 'orders.view'),
    ('Financeiro', 'orders.edit'),
    ('Financeiro', 'orders.cancel'),
    ('Financeiro', 'orders.resend_ticket'),
    ('Financeiro', 'finance.view'),
    ('Financeiro', 'finance.view_amounts'),
    ('Financeiro', 'finance.confirm_payment'),
    ('Financeiro', 'finance.refund'),
    ('Financeiro', 'finance.export'),
    ('Financeiro', 'finance.manage_fees'),
    ('Financeiro', 'reports.view'),
    ('Financeiro', 'reports.export'),

    ('Check-in', 'dashboard.view'),
    ('Check-in', 'participants.view'),
    ('Check-in', 'orders.view'),
    ('Check-in', 'checkin.view'),
    ('Check-in', 'checkin.scan'),
    ('Check-in', 'checkin.undo'),
    ('Check-in', 'checkin.view_history'),

    ('Entrega de kits', 'dashboard.view'),
    ('Entrega de kits', 'participants.view'),
    ('Entrega de kits', 'orders.view'),
    ('Entrega de kits', 'kits.view'),
    ('Entrega de kits', 'kits.deliver'),
    ('Entrega de kits', 'kits.view_history'),

    ('Estoque', 'dashboard.view'),
    ('Estoque', 'participants.view'),
    ('Estoque', 'inventory.view'),
    ('Estoque', 'inventory.add_order'),
    ('Estoque', 'inventory.adjust'),
    ('Estoque', 'inventory.change_participant_shirt'),
    ('Estoque', 'inventory.view_history'),
    ('Estoque', 'kits.view'),

    ('Suporte', 'dashboard.view'),
    ('Suporte', 'participants.view'),
    ('Suporte', 'participants.edit_basic'),
    ('Suporte', 'orders.view'),
    ('Suporte', 'orders.resend_ticket'),
    ('Suporte', 'kits.view'),
    ('Suporte', 'checkin.view'),

    ('Visualizacao', 'dashboard.view'),
    ('Visualizacao', 'participants.view'),
    ('Visualizacao', 'orders.view'),
    ('Visualizacao', 'finance.view'),
    ('Visualizacao', 'inventory.view'),
    ('Visualizacao', 'kits.view'),
    ('Visualizacao', 'checkin.view'),
    ('Visualizacao', 'events.view'),
    ('Visualizacao', 'batches.view'),
    ('Visualizacao', 'categories.view'),
    ('Visualizacao', 'coupons.view'),
    ('Visualizacao', 'imports.view'),
    ('Visualizacao', 'reports.view'),
    ('Visualizacao', 'team.view'),
    ('Visualizacao', 'audit.view')
)
insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from role_permissions rp
join public.admin_roles r on r.name = rp.role_name
join public.admin_permissions p on p.code = rp.permission_code
on conflict (role_id, permission_id) do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from public.admin_roles r
cross join public.admin_permissions p
where r.name = 'Owner'
on conflict (role_id, permission_id) do nothing;

insert into public.admin_users (user_id, role_id, is_active, internal_note)
select
  u.id,
  r.id,
  true,
  'Migracao automatica: usuario administrativo legado.'
from auth.users u
join public.admin_roles r on r.name = 'Administrador'
where not exists (
  select 1
  from public.admin_users au
  where au.user_id = u.id
)
on conflict (user_id) do nothing;

with owner_role as (
  select id from public.admin_roles where name = 'Owner' limit 1
), first_user as (
  select u.id
  from auth.users u
  join public.admin_users au on au.user_id = u.id
  order by u.created_at asc
  limit 1
)
update public.admin_users au
set role_id = owner_role.id,
    is_active = true,
    internal_note = coalesce(nullif(au.internal_note, ''), 'Usuario promovido automaticamente para Owner na migracao inicial.'),
    updated_at = now()
from owner_role, first_user
where au.user_id = first_user.id
  and not exists (
    select 1
    from public.admin_users au2
    join public.admin_roles ar2 on ar2.id = au2.role_id
    where ar2.name = 'Owner'
      and au2.is_active = true
  );

create or replace function public.is_active_owner(p_user_id uuid)
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
      and ar.name = 'Owner'
      and ar.is_active = true
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
  v_user_active boolean := false;
  v_permission_id uuid;
  v_is_owner boolean := false;
  v_has_deny boolean := false;
  v_has_allow boolean := false;
  v_has_role_permission boolean := false;
begin
  if p_user_id is null then
    return false;
  end if;

  if nullif(trim(coalesce(p_permission_code, '')), '') is null then
    return false;
  end if;

  select au.is_active
    into v_user_active
  from public.admin_users au
  where au.user_id = p_user_id;

  if coalesce(v_user_active, false) = false then
    return false;
  end if;

  if public.is_active_owner(p_user_id) then
    return true;
  end if;

  select id
    into v_permission_id
  from public.admin_permissions
  where code = p_permission_code
    and is_active = true
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
    from public.admin_users au
    join public.admin_roles ar on ar.id = au.role_id and ar.is_active = true
    join public.admin_role_permissions arp on arp.role_id = ar.id
    where au.user_id = p_user_id
      and au.is_active = true
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
  v_actor_can_manage_team boolean := false;
begin
  if v_actor_user_id is null then
    return false;
  end if;

  if p_user_id is null then
    return false;
  end if;

  if v_actor_user_id <> p_user_id then
    v_actor_is_owner := public.is_active_owner(v_actor_user_id);
    v_actor_can_manage_team := public.resolve_user_permission(v_actor_user_id, 'team.edit_permissions');

    if not v_actor_is_owner and not v_actor_can_manage_team then
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
  v_target_active boolean := false;
  v_target_role_id uuid;
  v_target_is_owner boolean := false;
  v_actor_can_view boolean := false;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if p_user_id is null then
    raise exception 'Usuario alvo obrigatorio.';
  end if;

  v_actor_can_view := public.current_user_has_permission('team.view') or public.current_user_has_permission('team.edit_permissions') or public.is_active_owner(v_actor_user_id);
  if not v_actor_can_view then
    raise exception 'Sem permissao para visualizar equipe.';
  end if;

  select au.is_active, au.role_id
    into v_target_active, v_target_role_id
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
  select
    u.id as user_id,
    coalesce(nullif(cp.full_name, ''), split_part(coalesce(u.email, ''), '@', 1)) as full_name,
    coalesce(u.email, '') as email,
    coalesce(ar.name, 'Sem funcao') as role_name,
    coalesce(au.is_active, false) as is_active,
    (
      select count(*)::integer
      from public.admin_permissions ap
      where ap.is_active = true
        and public.resolve_user_permission(u.id, ap.code)
    ) as effective_permission_count,
    u.last_sign_in_at as last_access_at
  from auth.users u
  left join public.admin_users au on au.user_id = u.id
  left join public.admin_roles ar on ar.id = au.role_id
  left join public.customer_profiles cp on cp.user_id = u.id
  where
    (
      v_search = ''
      or lower(coalesce(cp.full_name, '')) like ('%' || v_search || '%')
      or lower(coalesce(u.email, '')) like ('%' || v_search || '%')
    )
    and (
      v_role_filter = ''
      or lower(coalesce(ar.name, '')) = v_role_filter
    )
    and (
      v_status_filter = ''
      or (
        v_status_filter = 'active'
        and coalesce(au.is_active, false) = true
      )
      or (
        v_status_filter = 'inactive'
        and coalesce(au.is_active, false) = false
      )
    )
  order by coalesce(cp.full_name, u.email) asc;
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
  internal_note text,
  last_access_at timestamptz,
  is_owner boolean
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
    raise exception 'Sem permissao para visualizar equipe.';
  end if;

  return query
  select
    u.id as user_id,
    coalesce(nullif(cp.full_name, ''), split_part(coalesce(u.email, ''), '@', 1)) as full_name,
    coalesce(u.email, '') as email,
    au.role_id,
    coalesce(ar.name, 'Sem funcao') as role_name,
    coalesce(au.is_active, false) as is_active,
    au.internal_note,
    u.last_sign_in_at as last_access_at,
    public.is_active_owner(u.id) as is_owner
  from auth.users u
  left join public.admin_users au on au.user_id = u.id
  left join public.admin_roles ar on ar.id = au.role_id
  left join public.customer_profiles cp on cp.user_id = u.id
  where u.id = p_user_id;
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
  order by case when ar.name = 'Owner' then 0 else 1 end, ar.name;
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

create or replace function public.prevent_last_owner_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_role_id uuid;
  v_owner_count integer := 0;
  v_old_is_owner boolean := false;
  v_new_is_owner boolean := false;
  v_new_active boolean := true;
begin
  select id into v_owner_role_id
  from public.admin_roles
  where name = 'Owner'
  limit 1;

  if v_owner_role_id is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.role_id = v_owner_role_id and old.is_active then
      select count(*)::integer into v_owner_count
      from public.admin_users au
      where au.role_id = v_owner_role_id
        and au.is_active = true;

      if v_owner_count <= 1 then
        raise exception 'Nao e permitido remover o ultimo Owner ativo.';
      end if;
    end if;

    return old;
  end if;

  v_old_is_owner := old.role_id = v_owner_role_id and old.is_active = true;
  v_new_is_owner := new.role_id = v_owner_role_id;
  v_new_active := new.is_active;

  if v_old_is_owner and not (v_new_is_owner and v_new_active) then
    select count(*)::integer into v_owner_count
    from public.admin_users au
    where au.role_id = v_owner_role_id
      and au.is_active = true;

    if v_owner_count <= 1 then
      raise exception 'Nao e permitido desativar ou remover o ultimo Owner ativo.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_last_owner_update on public.admin_users;
create trigger trg_prevent_last_owner_update
before update on public.admin_users
for each row
execute function public.prevent_last_owner_mutation();

drop trigger if exists trg_prevent_last_owner_delete on public.admin_users;
create trigger trg_prevent_last_owner_delete
before delete on public.admin_users
for each row
execute function public.prevent_last_owner_mutation();

create or replace function public.upsert_admin_user_access(
  p_target_user_id uuid,
  p_role_id uuid,
  p_is_active boolean,
  p_internal_note text,
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
  v_actor_is_owner boolean := false;
  v_target_exists boolean := false;
  v_target_before_role_id uuid;
  v_target_before_active boolean := false;
  v_target_before_note text;
  v_target_before_is_owner boolean := false;
  v_target_after_is_owner boolean := false;
  v_role_name text;
  v_before_effective text[] := array[]::text[];
  v_after_effective text[] := array[]::text[];
  v_summary_add text[] := array[]::text[];
  v_summary_remove text[] := array[]::text[];
  v_override jsonb;
  v_permission_id uuid;
  v_permission_code text;
  v_effect text;
  v_critical_code text;
  v_permission_record record;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.edit_permissions') then
    raise exception 'Sem permissao para editar permissoes.';
  end if;

  v_actor_is_owner := public.is_active_owner(v_actor_user_id);

  select exists(select 1 from auth.users where id = p_target_user_id) into v_target_exists;
  if not v_target_exists then
    raise exception 'Usuario alvo nao encontrado.';
  end if;

  insert into public.admin_users (user_id, role_id, is_active, internal_note)
  values (p_target_user_id, p_role_id, coalesce(p_is_active, true), p_internal_note)
  on conflict (user_id) do nothing;

  select au.role_id, au.is_active, au.internal_note
    into v_target_before_role_id, v_target_before_active, v_target_before_note
  from public.admin_users au
  where au.user_id = p_target_user_id;

  v_target_before_is_owner := public.is_active_owner(p_target_user_id);

  select name into v_role_name
  from public.admin_roles
  where id = p_role_id
    and is_active = true
  limit 1;

  if p_role_id is not null and v_role_name is null then
    raise exception 'Funcao selecionada nao existe ou esta inativa.';
  end if;

  if v_target_before_is_owner and not v_actor_is_owner then
    raise exception 'Somente Owner pode alterar outro Owner.';
  end if;

  if v_role_name = 'Owner' and not v_actor_is_owner then
    raise exception 'Somente Owner pode conceder papel Owner.';
  end if;

  if coalesce(p_is_active, true) = false and not (v_actor_is_owner or public.current_user_has_permission('team.disable_user')) then
    raise exception 'Sem permissao para desativar usuarios administrativos.';
  end if;

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
    into v_before_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  if not v_actor_is_owner then
    for v_permission_record in
      with role_codes as (
        select p.code
        from public.admin_role_permissions arp
        join public.admin_permissions p on p.id = arp.permission_id
        where arp.role_id = p_role_id
          and p.is_active = true
      ), override_codes as (
        select
          trim(coalesce(item->>'permission_code', '')) as code,
          trim(coalesce(item->>'effect', '')) as effect
        from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
      ), denied as (
        select code from override_codes where effect = 'deny'
      ), allowed as (
        select code from override_codes where effect = 'allow'
      ), candidate as (
        select code from role_codes
        union
        select code from allowed
      )
      select c.code
      from candidate c
      where c.code <> ''
        and not exists (select 1 from denied d where d.code = c.code)
    loop
      if not public.resolve_user_permission(v_actor_user_id, v_permission_record.code) then
        raise exception 'Nao e permitido conceder permissao que voce nao possui: %', v_permission_record.code;
      end if;
    end loop;
  end if;

  if not v_actor_is_owner then
    foreach v_critical_code in array array['settings.manage', 'team.edit_permissions']
    loop
      if exists (
        select 1
        from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
        where trim(coalesce(item->>'permission_code', '')) = v_critical_code
          and trim(coalesce(item->>'effect', '')) = 'allow'
      ) then
        raise exception 'Somente Owner pode conceder permissao critica: %', v_critical_code;
      end if;
    end loop;

    if p_role_id is not null and exists (
      select 1
      from public.admin_role_permissions arp
      join public.admin_permissions ap on ap.id = arp.permission_id
      where arp.role_id = p_role_id
        and ap.code in ('settings.manage', 'team.edit_permissions')
    ) then
      raise exception 'Somente Owner pode atribuir funcao com permissoes criticas.';
    end if;
  end if;

  update public.admin_users au
  set
    role_id = p_role_id,
    is_active = coalesce(p_is_active, true),
    internal_note = p_internal_note,
    updated_at = now()
  where au.user_id = p_target_user_id;

  delete from public.admin_user_permission_overrides
  where user_id = p_target_user_id;

  for v_override in
    select item
    from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
  loop
    v_permission_code := trim(coalesce(v_override->>'permission_code', ''));
    v_effect := trim(coalesce(v_override->>'effect', ''));

    if v_permission_code = '' then
      continue;
    end if;

    if v_effect not in ('allow', 'deny') then
      continue;
    end if;

    select id into v_permission_id
    from public.admin_permissions
    where code = v_permission_code
      and is_active = true
    limit 1;

    if v_permission_id is null then
      continue;
    end if;

    insert into public.admin_user_permission_overrides (user_id, permission_id, effect)
    values (p_target_user_id, v_permission_id, v_effect)
    on conflict (user_id, permission_id)
    do update set effect = excluded.effect, updated_at = now();
  end loop;

  v_target_after_is_owner := public.is_active_owner(p_target_user_id);

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
    into v_after_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  select coalesce(array_agg(code), array[]::text[])
    into v_summary_add
  from (
    select code
    from unnest(v_after_effective) as code
    except
    select code
    from unnest(v_before_effective) as code
  ) as added_codes;

  select coalesce(array_agg(code), array[]::text[])
    into v_summary_remove
  from (
    select code
    from unnest(v_before_effective) as code
    except
    select code
    from unnest(v_after_effective) as code
  ) as removed_codes;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    details
  ) values (
    coalesce((select email from auth.users where id = v_actor_user_id), 'system'),
    'admin_user_access_updated',
    'admin_users',
    p_target_user_id,
    jsonb_build_object(
      'target_user_id', p_target_user_id,
      'before_role_id', v_target_before_role_id,
      'after_role_id', p_role_id,
      'before_is_active', v_target_before_active,
      'after_is_active', coalesce(p_is_active, true),
      'before_note', v_target_before_note,
      'after_note', p_internal_note,
      'before_is_owner', v_target_before_is_owner,
      'after_is_owner', v_target_after_is_owner,
      'overrides', coalesce(p_overrides, '[]'::jsonb),
      'allowed_permissions', v_summary_add,
      'denied_permissions', v_summary_remove,
      'reason', p_reason,
      'updated_at', now()
    )
  );

  return jsonb_build_object(
    'success', true,
    'added_permissions', v_summary_add,
    'removed_permissions', v_summary_remove,
    'target_user_id', p_target_user_id
  );
end;
$$;

create or replace function public.deliver_participant_kit_item(
  p_participant_id uuid,
  p_kit_item_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.participant_kit_items%rowtype;
  v_participant public.participants%rowtype;
  v_kit_item public.event_kit_items%rowtype;
  v_inventory public.shirt_inventory%rowtype;
begin
  if not public.current_user_has_permission('kits.deliver') then
    raise exception 'Sem permissao para entregar kit.';
  end if;

  if p_participant_id is null or p_kit_item_id is null then
    raise exception 'Participante e item sao obrigatorios.';
  end if;

  select * into v_item
  from public.participant_kit_items
  where participant_id = p_participant_id
    and kit_item_id = p_kit_item_id
  for update;

  if not found then
    raise exception 'Item do participante nao encontrado.';
  end if;

  if v_item.status = 'delivered' then
    raise exception 'Item ja foi entregue anteriormente.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if coalesce(v_participant.payment_status, 'pending') <> 'paid' then
    raise exception 'Pagamento pendente. Entrega bloqueada.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Entrega bloqueada.';
  end if;

  select * into v_kit_item
  from public.event_kit_items
  where id = p_kit_item_id;

  if not found then
    raise exception 'Configuracao de item nao encontrada.';
  end if;

  if v_kit_item.item_type = 'shirt' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para a camiseta do participante.';
    end if;

    if v_inventory.reserved_quantity < v_item.quantity then
      raise exception 'Reserva de camiseta insuficiente para entrega.';
    end if;

    update public.shirt_inventory
    set reserved_quantity = reserved_quantity - v_item.quantity,
        delivered_quantity = delivered_quantity + v_item.quantity,
        updated_at = now()
    where id = v_inventory.id;
  end if;

  update public.participant_kit_items
  set status = 'delivered',
      delivered_at = now()
  where id = v_item.id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    'participant_kit_item_delivered',
    'participant_kit_items',
    v_item.id,
    v_item.event_id,
    jsonb_build_object(
      'participant_id', p_participant_id,
      'kit_item_id', p_kit_item_id,
      'item_type', v_kit_item.item_type,
      'quantity', v_item.quantity
    )
  );

  return true;
end;
$$;

create or replace function public.deliver_participant_full_kit(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  if not public.current_user_has_permission('kits.deliver') then
    raise exception 'Sem permissao para entregar kit.';
  end if;

  for v_row in
    select pki.kit_item_id
    from public.participant_kit_items pki
    where pki.participant_id = p_participant_id
      and pki.status <> 'delivered'
  loop
    perform public.deliver_participant_kit_item(p_participant_id, v_row.kit_item_id);
  end loop;

  return true;
end;
$$;

create or replace function public.checkin_participant_entry(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_ticket public.tickets%rowtype;
begin
  if not public.current_user_has_permission('checkin.scan') then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if coalesce(v_participant.payment_status, 'pending') <> 'paid' then
    raise exception 'Pagamento pendente. Check-in bloqueado.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Check-in bloqueado.';
  end if;

  select * into v_ticket
  from public.tickets
  where participant_id = p_participant_id
  order by issued_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Ingresso ja utilizado anteriormente.';
  end if;

  update public.tickets
  set status = 'used',
      used_at = now()
  where id = v_ticket.id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    'participant_checkin_entry',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'used_at', now()
    )
  );

  return true;
end;
$$;

revoke all on function public.deliver_participant_kit_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.deliver_participant_full_kit(uuid) from public, anon, authenticated;
revoke all on function public.checkin_participant_entry(uuid) from public, anon, authenticated;

grant execute on function public.deliver_participant_kit_item(uuid, uuid) to authenticated;
grant execute on function public.deliver_participant_full_kit(uuid) to authenticated;
grant execute on function public.checkin_participant_entry(uuid) to authenticated;

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