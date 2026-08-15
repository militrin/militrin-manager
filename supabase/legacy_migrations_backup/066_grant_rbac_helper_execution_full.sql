-- 066_grant_rbac_helper_execution_full.sql
-- Garante execucao das funcoes auxiliares de RBAC para usuarios autenticados.

begin;

grant execute
on function public.is_active_owner(uuid)
to authenticated;

grant execute
on function public.resolve_user_permission(uuid, text)
to authenticated;

grant execute
on function public.current_user_has_permission(text)
to authenticated;

commit;
