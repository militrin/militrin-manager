-- Divide o Dashboard em blocos independentes. dashboard.view permanece ativo
-- somente por compatibilidade de catalogo; a aplicacao deixa de usa-lo para
-- autorizar /painel ou carregar indicadores.
begin;

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('dashboard.integrity.view', 'Ver integridade operacional no Dashboard', 'Visualiza alertas e verificacoes de integridade operacional no Dashboard.', 'dashboard', 11, true),
  ('dashboard.people.view', 'Ver pessoas e inscricoes no Dashboard', 'Visualiza indicadores de pessoas, inscricoes e seus estados no Dashboard.', 'dashboard', 12, true),
  ('dashboard.operations.view', 'Ver ingressos e operacao no Dashboard', 'Visualiza indicadores de ingressos, check-in e entrega de kits no Dashboard.', 'dashboard', 13, true),
  ('dashboard.inventory.view', 'Ver estoque no Dashboard', 'Visualiza indicadores consolidados de estoque de camisetas no Dashboard.', 'dashboard', 14, true),
  ('dashboard.finance.view', 'Ver financeiro no Dashboard', 'Habilita o bloco financeiro do Dashboard quando o usuario tambem possui permissao para visualizar valores.', 'dashboard', 15, true)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = true;

-- A role Operacional precisa existir para que os presets desta migration ja
-- referenciem exclusivamente as seis funcoes finais.
insert into public.admin_roles (code, name, description, is_system, is_active)
values ('operational', 'Operacional', 'Atendimento ao participante e operacoes do evento.', true, true)
on conflict (code) do update set
  name = excluded.name, description = excluded.description,
  is_system = true, is_active = true;

-- Presets revisados e explicitamente documentados na auditoria:
-- administrator: todos os blocos
-- operational: pessoas e operacao
-- finance: financeiro
-- marketing: nenhum bloco
-- viewer: pessoas e operacao
-- owner nao precisa de linhas: resolve_user_permission concede tudo ao Owner.
with preset(role_code, permission_code) as (
  values
    ('administrator', 'dashboard.integrity.view'),
    ('administrator', 'dashboard.people.view'),
    ('administrator', 'dashboard.operations.view'),
    ('administrator', 'dashboard.inventory.view'),
    ('administrator', 'dashboard.finance.view'),
    ('operational', 'dashboard.people.view'),
    ('operational', 'dashboard.operations.view'),
    ('finance', 'dashboard.finance.view'),
    ('viewer', 'dashboard.people.view'),
    ('viewer', 'dashboard.operations.view')
), inserted as (
  insert into public.admin_role_permissions (role_id, permission_id)
  select r.id, p.id
  from preset x
  join public.admin_roles r on r.code = x.role_code and r.is_active = true
  join public.admin_permissions p on p.code = x.permission_code and p.is_active = true
  on conflict (role_id, permission_id) do nothing
  returning role_id, permission_id
)
select count(*) from inserted;

-- O editor de funcoes lista admin_permissions dinamicamente. Incluir os novos
-- grants no snapshot preserva o comportamento de "Restaurar padrao" sem
-- alterar ou apagar customizacoes e overrides individuais existentes.
insert into public.admin_role_permissions_system_default (role_id, permission_id)
select arp.role_id, arp.permission_id
from public.admin_role_permissions arp
join public.admin_permissions p on p.id = arp.permission_id
where p.code like 'dashboard.%.view'
on conflict (role_id, permission_id) do nothing;

commit;
