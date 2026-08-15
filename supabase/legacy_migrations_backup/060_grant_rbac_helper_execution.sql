-- 060_grant_rbac_helper_execution.sql
-- Permite que usuários autenticados executem as funções auxiliares usadas pelas policies RLS.

begin;

grant execute
on function public.is_active_owner(uuid)
to authenticated;

grant execute
on function public.resolve_user_permission(uuid, text)
to authenticated;

commit;