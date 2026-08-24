-- Relatorio de Operacoes (Historico de Operacoes + Snapshot de Contingencia):
-- permissao dedicada, separada de reports.view/reports.export (que hoje so
-- financeiro e marketing tem -- ver 20260879000000_consolidate_admin_roles.sql).
-- Operacional precisa acessar este relatorio especifico sem ganhar acesso aos
-- demais relatorios do catalogo geral (financeiro, cupons, etc); Financeiro
-- nao deve ganhar isto so por ja ter reports.view. Ver a pagina dedicada em
-- src/app/operacoes/relatorio (fora de /relatorios, que e gateado por
-- reports.view) -- assim nenhuma permissao existente precisa mudar.
begin;

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values (
  'operations.view_report',
  'Ver relatorio de operacoes',
  'Visualiza e exporta o Historico de Operacoes (log imutavel de acoes) e o Snapshot de Contingencia do evento',
  'operations',
  60,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

-- O preset de Administrador em 20260879000000 fez um "cross join com todas as
-- permissoes ativas" NA HORA -- roda uma vez, nao reage a permissoes futuras.
-- Por isso concedemos aqui explicitamente pra Administrator e Operacional.
-- Owner e especial e bypassa admin_role_permissions em resolve_user_permission.
insert into public.admin_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.admin_roles role
join public.admin_permissions permission on permission.code = 'operations.view_report'
where role.code in ('administrator', 'operational')
on conflict (role_id, permission_id) do nothing;

-- Mantem consistente com o "Restaurar padrao" do editor de funcoes.
insert into public.admin_role_permissions_system_default (role_id, permission_id)
select arp.role_id, arp.permission_id
from public.admin_role_permissions arp
join public.admin_roles r on r.id = arp.role_id
join public.admin_permissions p on p.id = arp.permission_id
where p.code = 'operations.view_report' and r.code in ('administrator', 'operational')
on conflict do nothing;

commit;
