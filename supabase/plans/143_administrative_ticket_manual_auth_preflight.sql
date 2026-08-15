-- 143_administrative_ticket_manual_auth_preflight.sql
-- Sem mutacoes persistentes. Confirma a identidade/permissao usada no teste controlado.

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','e8f5777b-3ed1-409d-b3f1-71724be5a09e',true);
select set_config('request.jwt.claim.role','authenticated',true);

select auth.uid() as actor_user_id,current_user as database_role,
  public.current_user_has_permission('participants.create') as can_create_participants,
  public.user_can_access_organization(
    auth.uid(),
    (select organization_id from public.events where id='6c931940-03ad-48c2-836c-754924a00d00')
  ) as can_access_event_organization;

rollback;
