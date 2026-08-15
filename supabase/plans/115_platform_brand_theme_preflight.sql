-- 115_platform_brand_theme_preflight.sql
-- Preflight da 115: confirma que platform_settings ainda nao existe e que
-- current_user_has_permission/settings.manage ja estao disponiveis (usados pela
-- nova RPC set_platform_brand_theme).

select to_regclass('public.platform_settings') as existing_table;

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'current_user_has_permission';

select code from public.admin_permissions where code = 'settings.manage';
