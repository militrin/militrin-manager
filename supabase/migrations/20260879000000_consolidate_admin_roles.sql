-- Consolida as funcoes administrativas em seis presets. Membros existentes
-- passam a herdar o preset final correspondente; overrides individuais
-- existentes permanecem intactos e continuam com precedencia.
begin;

insert into public.admin_roles (code, name, description, is_system, is_active)
values ('operational', 'Operacional', 'Atendimento ao participante e operacoes do evento.', true, true)
on conflict (code) do update set
  name = excluded.name, description = excluded.description,
  is_system = true, is_active = true;

update public.admin_roles set name = 'Administrador', description = 'Administracao ampla da organizacao e dos eventos.', is_active = true where code = 'administrator';
update public.admin_roles set name = 'Financeiro', description = 'Pagamentos, receitas, conciliacao, estornos e relatorios financeiros.', is_active = true where code = 'finance';
update public.admin_roles set name = 'Marketing', description = 'Conteudo, fotos, patrocinadores, publico e relatorios nao financeiros.', is_active = true where code = 'marketing';
update public.admin_roles set name = 'Visualizador', description = 'Leitura administrativa minima, ampliavel por overrides individuais.', is_active = true where code = 'viewer';

create temporary table role_consolidation_map on commit drop as
select old_role.id old_role_id, target_role.id target_role_id, old_role.code old_code
from (values
  ('administrator', 'administrator'), ('manager', 'administrator'), ('inventory', 'administrator'),
  ('finance', 'finance'), ('checkin', 'operational'), ('kit_delivery', 'operational'),
  ('support', 'operational'), ('marketing', 'marketing'), ('viewer', 'viewer')
) mapping(old_code, target_code)
join public.admin_roles old_role on old_role.code = mapping.old_code
join public.admin_roles target_role on target_role.code = mapping.target_code;

-- Presets finais. Owner continua especial em resolve_user_permission.
delete from public.admin_role_permissions arp
using public.admin_roles r
where arp.role_id = r.id and r.code in ('administrator', 'operational', 'finance', 'marketing', 'viewer');

-- Administrador preserva o comportamento administrativo amplo atual, sem se
-- tornar Owner: operacoes exclusivas continuam protegidas por is_active_owner.
insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id from public.admin_roles r cross join public.admin_permissions p
where r.code = 'administrator' and p.is_active
on conflict do nothing;

with preset(role_code, permission_code) as (values
  ('operational', 'dashboard.people.view'),
  ('operational', 'dashboard.operations.view'),
  ('operational', 'participants.view'),
  ('operational', 'participants.edit_basic'),
  ('operational', 'orders.view'),
  ('operational', 'orders.resend_ticket'),
  ('operational', 'checkin.view'),
  ('operational', 'checkin.scan'),
  ('operational', 'checkin.view_history'),
  ('operational', 'kits.view'),
  ('operational', 'kits.deliver'),
  ('operational', 'kits.view_history'),
  ('operational', 'wristbands.view'),
  ('operational', 'wristbands.link'),
  ('operational', 'inventory.change_participant_shirt'),
  ('operational', 'store.deliver'),

  ('finance', 'dashboard.finance.view'),
  ('finance', 'orders.view'),
  ('finance', 'finance.view'),
  ('finance', 'finance.view_amounts'),
  ('finance', 'finance.confirm_payment'),
  ('finance', 'finance.refund'),
  ('finance', 'finance.export'),
  ('finance', 'finance.manage_accounts'),
  ('finance', 'finance.manage_categories'),
  ('finance', 'finance.manage_entries'),
  ('finance', 'finance.manage_expenses'),
  ('finance', 'finance.manage_income'),
  ('finance', 'finance.manage_suppliers'),
  ('finance', 'finance.reconcile'),
  ('finance', 'finance.approve_refund'),
  ('finance', 'reports.view'),
  ('finance', 'reports.export'),

  ('marketing', 'participants.view'),
  ('marketing', 'events.view'),
  ('marketing', 'photos.view_admin'),
  ('marketing', 'photos.upload'),
  ('marketing', 'photos.publish'),
  ('marketing', 'photos.delete'),
  ('marketing', 'sponsors.view'),
  ('marketing', 'sponsors.manage'),
  ('marketing', 'reports.view'),

  ('viewer', 'dashboard.people.view'),
  ('viewer', 'dashboard.operations.view'),
  ('viewer', 'participants.view'),
  ('viewer', 'orders.view')
)
insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from preset x
join public.admin_roles r on r.code = x.role_code
join public.admin_permissions p on p.code = x.permission_code and p.is_active
on conflict do nothing;

-- Nenhum delete/insert e feito em admin_user_permission_overrides. Os allows
-- e denies existentes seguem vencendo o novo preset via resolve_user_permission.
update public.admin_users au set role_id = m.target_role_id
from role_consolidation_map m where au.role_id = m.old_role_id;

update public.admin_roles set is_active = false
where code in ('manager', 'inventory', 'checkin', 'kit_delivery', 'support');

-- Fonte unica dos filtros/selects da Equipe: mesmo que uma role legada seja
-- reativada manualmente, ela nao volta a ser oferecida para novos membros.
create or replace function public.list_admin_roles()
returns table(id uuid, name text, description text, is_active boolean, is_system boolean)
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  if auth.uid() is null then raise exception 'Usuario autenticado obrigatorio.'; end if;
  if not public.current_user_has_permission('team.view') then raise exception 'Sem permissao para visualizar funcoes.'; end if;

  return query
  select ar.id, ar.name, ar.description, ar.is_active, ar.is_system
  from public.admin_roles ar
  where ar.is_active = true
    and ar.code in ('owner', 'administrator', 'operational', 'finance', 'marketing', 'viewer')
  order by array_position(array['owner', 'administrator', 'operational', 'finance', 'marketing', 'viewer'], ar.code);
end; $$;

revoke all on function public.list_admin_roles() from public;
grant execute on function public.list_admin_roles() to authenticated, service_role;

-- Atualiza somente os defaults das cinco funcoes editaveis consolidadas.
delete from public.admin_role_permissions_system_default d
using public.admin_roles r
where d.role_id = r.id and r.code in ('administrator', 'operational', 'finance', 'marketing', 'viewer');
insert into public.admin_role_permissions_system_default (role_id, permission_id)
select arp.role_id, arp.permission_id
from public.admin_role_permissions arp
join public.admin_roles r on r.id = arp.role_id
where r.code in ('administrator', 'operational', 'finance', 'marketing', 'viewer')
on conflict do nothing;

commit;
