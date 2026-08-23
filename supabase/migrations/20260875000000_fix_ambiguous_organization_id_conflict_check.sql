-- ============================================================================
-- BUG CRITICO EM PRODUCAO: find_conflicting_registration_contact
-- (20260873000000) SEMPRE falhava com
--   ERROR 42702: column reference "organization_id" is ambiguous
-- para QUALQUER chamada, com qualquer CPF -- nao so os que colidem.
--
-- CAUSA RAIZ: a assinatura da funcao e
--   RETURNS TABLE("has_conflict" boolean, "organization_id" "uuid")
-- Em plpgsql, cada coluna de um RETURNS TABLE vira uma variavel de saida
-- implicitamente declarada com aquele nome -- ou seja, "organization_id"
-- passou a existir simultaneamente como (a) essa variavel de saida e (b) a
-- coluna organization_id de public.registration_contacts, referenciada sem
-- qualificador dentro do proprio corpo:
--   select id, user_id into v_existing from public.registration_contacts
--     where organization_id = v_org_id and cpf = v_cpf;
-- O Postgres nao consegue decidir qual dos dois "organization_id" o WHERE
-- quer dizer e recusa a query inteira -- SEMPRE, nao so quando ha conflito
-- de CPF de verdade.
--
-- IMPACTO REAL (confirmado lendo o estado atual do banco, nao suposto):
--   1. find_conflicting_registration_contact nunca retornava um resultado
--      valido -- sempre erro. signUpPublicAccountAction e
--      completeFirstAccessAction tratam erro da RPC como
--      "if (!conflictError) { checar conflito }" -- ou seja, com erro elas
--      SIMPLESMENTE PULAM a checagem e deixam o fluxo continuar. Essa e a
--      causa raiz exata do bug relatado: CPF duplicado nunca era bloqueado
--      em /criar-conta, apesar do codigo estar "certo" na leitura.
--   2. ensure_registration_contact_for_user (20260874000000) CHAMA
--      find_conflicting_registration_contact internamente como guarda
--      canonica -- e com ela sempre falhando, ensure_registration_contact_for_user
--      tambem passou a falhar para QUALQUER usuario (confirmado testando
--      diretamente contra a conta original/canonica, nao so contas
--      duplicadas). Ou seja: desde que 20260873000000/20260874000000 foram
--      aplicadas, NENHUMA conta nova materializou registration_contact --
--      regressao total do fix original (20260870000000).
--
-- CORRECAO MINIMA: renomear a coluna de saida "organization_id" (que nunca
-- e sequer usada pelos chamadores em TS -- so `has_conflict` e lida em
-- src/app/inscricao/actions.ts e src/app/primeiro-acesso/actions.ts) e
-- qualificar as colunas da tabela com alias, pra nunca mais depender de
-- nomes implicitos coincidirem. Nenhuma outra logica muda -- mesma regra,
-- mesma assinatura de entrada, mesmo comportamento pretendido desde
-- 20260873000000. CREATE OR REPLACE nao pode trocar o tipo de retorno de
-- uma funcao existente, entao precisa de DROP antes.
-- ============================================================================

DROP FUNCTION IF EXISTS "public"."find_conflicting_registration_contact"("text", "uuid", "uuid");

CREATE FUNCTION "public"."find_conflicting_registration_contact"(
  "p_cpf" "text",
  "p_exclude_user_id" "uuid" DEFAULT NULL::"uuid",
  "p_organization_id" "uuid" DEFAULT NULL::"uuid"
)
RETURNS TABLE("has_conflict" boolean, "resolved_organization_id" "uuid")
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public', 'pg_temp'
AS $$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  v_org_id uuid := p_organization_id;
  v_existing record;
begin
  if length(v_cpf) <> 11 then
    has_conflict := false;
    resolved_organization_id := null;
    return next;
    return;
  end if;

  if v_org_id is null then
    v_org_id := public.resolve_default_registration_organization();
  end if;

  if v_org_id is null then
    has_conflict := false;
    resolved_organization_id := null;
    return next;
    return;
  end if;

  select rc.id, rc.user_id into v_existing
    from public.registration_contacts rc
    where rc.organization_id = v_org_id and rc.cpf = v_cpf;

  has_conflict := found and v_existing.user_id is not null and v_existing.user_id is distinct from p_exclude_user_id;
  resolved_organization_id := v_org_id;
  return next;
end;
$$;

ALTER FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";
