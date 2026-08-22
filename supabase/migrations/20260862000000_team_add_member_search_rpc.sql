-- ============================================================================
-- Fluxo "Adicionar membro" em Equipe e permissoes -- busca somente-leitura
-- de contas existentes que ainda NAO estao em admin_users.
-- ============================================================================
-- Nenhum sistema de permissao novo: reaproveita admin_users/admin_roles/
-- admin_permissions/admin_user_permission_overrides ja existentes (RBAC
-- atual, ver current_user_has_permission/resolve_user_permission). A
-- mutacao de promover alguem continua sendo o RPC canonico ja existente
-- upsert_admin_user_access -- esta migration so adiciona a busca que faltava
-- pra achar o usuario sem precisar do UUID manualmente.
--
-- Mesmo padrao de seguranca/privacidade ja usado em
-- search_admin_ticket_owner_accounts: minimo de 3 caracteres pra buscar,
-- e-mail sempre mascarado no retorno (nunca o e-mail completo), limite de
-- 20 resultados. Gate de permissao DENTRO do proprio RPC (SECURITY
-- DEFINER) -- protecao de backend, nao so escondendo o botao na UI.
CREATE OR REPLACE FUNCTION "public"."search_promotable_admin_users"("p_term" "text")
RETURNS TABLE("user_id" "uuid", "full_name" "text", "masked_email" "text")
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public', 'pg_temp'
AS $$
declare
  v_actor uuid := auth.uid();
  v_term text := trim(coalesce(p_term, ''));
begin
  if v_actor is null or not public.current_user_has_permission('team.edit_permissions') then
    raise exception 'Sem permissao para buscar usuarios para a equipe.';
  end if;

  if length(v_term) < 3 then
    raise exception 'Informe ao menos 3 caracteres para buscar.';
  end if;

  return query
  select
    u.id,
    coalesce(nullif(trim(cp.full_name), ''), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)),
    case when position('@' in coalesce(u.email, '')) > 1 then left(u.email, 2) || '***@' || split_part(u.email, '@', 2) end
  from auth.users u
  left join public.customer_profiles cp on cp.user_id = u.id
  where u.id <> v_actor
    -- "nao listar usuarios ja membros": qualquer linha existente em
    -- admin_users (ativa ou inativa) exclui o usuario da busca -- reativar
    -- alguem ja removido continua sendo feito pelo editor individual
    -- existente (/equipe/[userId]), nunca por este fluxo de "novo membro".
    and not exists (select 1 from public.admin_users au where au.user_id = u.id)
    and (
      coalesce(cp.full_name, u.raw_user_meta_data ->> 'full_name', '') ilike ('%' || v_term || '%')
      or coalesce(u.email, '') ilike ('%' || v_term || '%')
    )
  order by 2, u.id
  limit 20;
end;
$$;

ALTER FUNCTION "public"."search_promotable_admin_users"("p_term" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."search_promotable_admin_users"("p_term" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_promotable_admin_users"("p_term" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_promotable_admin_users"("p_term" "text") TO "service_role";
