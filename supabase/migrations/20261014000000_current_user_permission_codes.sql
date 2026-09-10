-- Mapa agregado de permissoes do usuario autenticado.
-- Substitui N chamadas a current_user_has_permission por 1 RPC.
-- Semantica alinhada a resolve_user_permission (owner / role / allow / deny).
-- auth.uid() obrigatorio; nunca devolve permissoes de terceiros.

begin;

create or replace function public.current_user_permission_codes()
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role_id uuid;
  v_is_active boolean := false;
  v_is_owner boolean := false;
  v_codes text[];
begin
  if v_actor is null then
    return array[]::text[];
  end if;

  select au.role_id, au.is_active
    into v_role_id, v_is_active
  from public.admin_users au
  where au.user_id = v_actor;

  if not coalesce(v_is_active, false) then
    return array[]::text[];
  end if;

  select exists (
    select 1
    from public.admin_roles ar
    where ar.id = v_role_id
      and ar.is_active = true
      and ar.code = 'owner'
  ) into v_is_owner;

  if v_is_owner then
    select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
      into v_codes
    from public.admin_permissions ap
    where ap.is_active = true;
    return v_codes;
  end if;

  select coalesce(array_agg(granted.code order by granted.code), array[]::text[])
    into v_codes
  from (
    select ap.code
    from public.admin_permissions ap
    where ap.is_active = true
      and not exists (
        select 1
        from public.admin_user_permission_overrides uo
        where uo.user_id = v_actor
          and uo.permission_id = ap.id
          and uo.effect = 'deny'
      )
      and (
        exists (
          select 1
          from public.admin_user_permission_overrides uo
          where uo.user_id = v_actor
            and uo.permission_id = ap.id
            and uo.effect = 'allow'
        )
        or exists (
          select 1
          from public.admin_role_permissions arp
          join public.admin_roles ar on ar.id = arp.role_id and ar.is_active = true
          where arp.role_id = v_role_id
            and arp.permission_id = ap.id
        )
      )
  ) granted;

  return v_codes;
end;
$$;

comment on function public.current_user_permission_codes() is
  'Permissoes efetivas do auth.uid(). Vazio se anonimo, inativo ou sem papel admin. Nunca lista outro usuario.';

revoke all on function public.current_user_permission_codes() from public, anon;
grant execute on function public.current_user_permission_codes() to authenticated;

commit;
