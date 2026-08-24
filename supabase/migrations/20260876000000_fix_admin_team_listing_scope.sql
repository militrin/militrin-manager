-- ============================================================================
-- BUG: /configuracoes/equipe listava TODO auth.users (qualquer conta comum,
-- de comprador de ingresso a cadastro sem nenhum vinculo administrativo)
-- como se fosse membro da equipe -- aparecendo como "Sem funcao",
-- "Cancelado" (badge de is_active=false) e "0 permissoes".
--
-- CAUSA RAIZ: list_admin_team partia de "from auth.users u left join
-- public.admin_users au" -- ou seja, TODA conta do sistema virava uma linha
-- da tabela "base", com admin_users so preenchendo funcao/status quando
-- existia. Qualquer comprador de ingresso, sem nenhum registro em
-- admin_users, aparecia do mesmo jeito, so que com os campos vazios.
-- organization_members NAO estava envolvida nessa funcao (nao e essa a
-- causa) -- confirmado lendo o corpo inteiro, so auth.users/admin_users/
-- admin_roles/customer_profiles participam.
--
-- CORRECAO: inverter a base da query -- partir de admin_users (so quem
-- realmente tem vinculo administrativo) e so entao juntar auth.users (INNER,
-- nao LEFT: admin_users.user_id ja tem FK ON DELETE CASCADE pra auth.users,
-- entao uma conta apagada nunca deixa admin_users orfao -- INNER e so pra
-- deixar essa garantia explicita na propria query, nao decorativo). Membro
-- inativo continua aparecendo (is_active vem direto da coluna real de
-- admin_users, nunca mais de um coalesce pra false por ausencia de linha).
-- Nenhuma outra regra muda -- mesmos filtros de busca/funcao/status, mesma
-- checagem de permissao 'team.view'.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."list_admin_team"("p_search" "text" DEFAULT NULL::"text", "p_role_name" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("user_id" "uuid", "full_name" "text", "email" "text", "role_name" "text", "is_active" boolean, "effective_permission_count" integer, "last_access_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  with base as (
    select
      au.user_id as user_id,
      coalesce(nullif(trim(cp.full_name), ''), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)) as full_name,
      lower(u.email) as email,
      ar.name as role_name,
      au.is_active as is_active,
      u.last_sign_in_at as last_access_at
    from public.admin_users au
    join auth.users u on u.id = au.user_id
    left join public.admin_roles ar on ar.id = au.role_id
    left join public.customer_profiles cp on cp.user_id = u.id
  )
  select
    b.user_id,
    b.full_name,
    b.email,
    b.role_name,
    b.is_active,
    (
      select count(*)::integer
      from public.admin_permissions p
      where p.is_active = true
        and public.resolve_user_permission(b.user_id, p.code)
    ) as effective_permission_count,
    b.last_access_at
  from base b
  where (
      v_search = ''
      or lower(coalesce(b.full_name, '')) like '%' || v_search || '%'
      or lower(coalesce(b.email, '')) like '%' || v_search || '%'
    )
    and (
      v_role_filter = ''
      or lower(coalesce(b.role_name, '')) = v_role_filter
    )
    and (
      v_status_filter = ''
      or (v_status_filter = 'active' and b.is_active = true)
      or (v_status_filter = 'inactive' and b.is_active = false)
    )
  order by b.full_name nulls last, b.email;
end;
$$;

ALTER FUNCTION "public"."list_admin_team"("p_search" "text", "p_role_name" "text", "p_status" "text") OWNER TO "postgres";
