-- 116_store_module_foundation_preflight.sql
-- Preflight da 116: confirma que nenhuma tabela store_* existe ainda e que as
-- dependencias (organizations, events, admin_permissions, admin_roles,
-- admin_role_permissions, audit_logs, user_can_access_organization,
-- current_user_has_permission) estao presentes antes de criar o modulo novo
-- da lojinha.

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('store_items', 'store_item_variants', 'store_item_inventory', 'store_orders', 'store_order_items');
-- esperado: 0 linhas (nenhuma tabela deve existir ainda)

select to_regclass('public.organizations') as organizations,
       to_regclass('public.events') as events,
       to_regclass('public.admin_permissions') as admin_permissions,
       to_regclass('public.admin_roles') as admin_roles,
       to_regclass('public.admin_role_permissions') as admin_role_permissions,
       to_regclass('public.audit_logs') as audit_logs,
       to_regclass('public.participants') as participants;

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('user_can_access_organization', 'current_user_has_permission');

select code from public.admin_roles where code in ('owner', 'administrator', 'manager', 'inventory', 'kit_delivery');
