-- ============================================================================
-- Auditoria (read-only) pedida no ticket anterior: uma conta nova
-- ("ADMIN DOGUI", hdogui@gmail.com) nao ganhou seu proprio registration_contact
-- em /cadastros. Causa raiz confirmada: NAO e bug -- ensure_registration_contact_for_user
-- (20260870000000) rodou (updated_at do contato existente saltou no mesmo
-- instante da criacao da conta), casou por CPF com um registration_contact
-- ja vinculado a OUTRA conta (mesma pessoa real, CPF identico, testando com
-- e-mail diferente) e corretamente NAO reatribuiu a Pessoa (coalesce(user_id,
-- p_user_id) preserva o vinculo original) -- exatamente a regra "Pessoa
-- existente por CPF -> vincula, nao duplica" pedida na especificacao
-- original. A conta nova ficou sem Cadastro proprio silenciosamente.
--
-- Decisao (opcao 2 escolhida): em vez de manter esse merge silencioso,
-- avisar no momento da criacao/conclusao da conta que o CPF ja pertence a
-- outra conta, ANTES de a conta nova existir de fato -- nunca depois, nunca
-- silenciosamente.
--
-- Nao duplicamos a regra de negocio: extraimos a resolucao de organizacao
-- default (hoje so existe 1 organizacao ativa) para uma funcao propria,
-- resolve_default_registration_organization(), e tanto
-- ensure_registration_contact_for_user quanto a funcao nova abaixo passam a
-- chamar essa mesma funcao -- um unico lugar decide "qual organizacao usar
-- quando nenhuma foi informada".
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."resolve_default_registration_organization"()
RETURNS "uuid"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public', 'pg_temp'
AS $$
declare
  v_org_ids uuid[];
begin
  select array_agg(id) into v_org_ids
    from (select id from public.organizations where status = 'active' order by created_at asc limit 2) s;
  if coalesce(array_length(v_org_ids, 1), 0) <> 1 then
    return null;
  end if;
  return v_org_ids[1];
end;
$$;

ALTER FUNCTION "public"."resolve_default_registration_organization"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."resolve_default_registration_organization"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_default_registration_organization"() TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_default_registration_organization"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_default_registration_organization"() TO "service_role";

-- Mesmo corpo de 20260870000000, so trocando o bloco de resolucao de
-- organizacao inline pela chamada a resolve_default_registration_organization()
-- acima. Nenhuma outra linha muda.
CREATE OR REPLACE FUNCTION "public"."ensure_registration_contact_for_user"(
  "p_user_id" "uuid",
  "p_organization_id" "uuid" DEFAULT NULL::"uuid"
)
RETURNS "uuid"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public', 'pg_temp'
AS $$
declare
  v_actor uuid := auth.uid();
  v_profile record;
  v_email text;
  v_cpf text;
  v_contact_id uuid;
  v_existing record;
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  if v_actor is not null and v_actor <> p_user_id
     and not public.current_user_has_permission('participants.create') then
    raise exception 'Sem permissao para vincular este cadastro.';
  end if;

  select full_name, cpf, birth_date, gender, phone, city
    into v_profile
    from public.customer_profiles
    where user_id = p_user_id;

  if not found then
    return null;
  end if;

  select email into v_email from auth.users where id = p_user_id;
  v_cpf := regexp_replace(coalesce(v_profile.cpf, ''), '\D', '', 'g');

  if length(v_cpf) <> 11
     or nullif(trim(coalesce(v_profile.full_name, '')), '') is null
     or v_profile.birth_date is null
     or nullif(trim(coalesce(v_profile.phone, '')), '') is null
     or nullif(trim(coalesce(v_email, '')), '') is null
  then
    return null;
  end if;

  if p_organization_id is null then
    p_organization_id := public.resolve_default_registration_organization();
    if p_organization_id is null then
      return null;
    end if;
  end if;

  -- Guarda canonica: CPF ja vinculado a OUTRA conta nunca e mesclado
  -- silenciosamente (reusa find_conflicting_registration_contact, a mesma
  -- checagem que /criar-conta e /primeiro-acesso ja fazem ANTES de chegar
  -- aqui -- isso e so a rede de seguranca de verdade, que vale pra qualquer
  -- chamador presente ou futuro desta funcao, nao so pra quem lembrar de
  -- checar antes). "user_id IS NULL" ou "user_id = p_user_id" nunca entram
  -- aqui (find_conflicting_registration_contact exclui os dois via
  -- p_exclude_user_id) -- seguem normalmente pro branch de match por CPF
  -- logo abaixo, que vincula (NULL) ou so atualiza (idempotente).
  if (select fc.has_conflict from public.find_conflicting_registration_contact(v_cpf, p_user_id, p_organization_id) fc) then
    raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
      detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
  end if;

  -- ja vinculado nesta organizacao: idempotente, so preenche lacunas.
  select id into v_contact_id
    from public.registration_contacts
    where organization_id = p_organization_id and user_id = p_user_id;

  if v_contact_id is not null then
    update public.registration_contacts set
      full_name = coalesce(nullif(trim(full_name), ''), trim(v_profile.full_name)),
      birth_date = coalesce(birth_date, v_profile.birth_date),
      gender = coalesce(nullif(trim(coalesce(gender, '')), ''), nullif(trim(coalesce(v_profile.gender, '')), '')),
      phone = coalesce(nullif(trim(coalesce(phone, '')), ''), trim(v_profile.phone)),
      city = coalesce(nullif(trim(coalesce(city, '')), ''), nullif(trim(coalesce(v_profile.city, '')), '')),
      updated_at = now()
      where id = v_contact_id;
    return v_contact_id;
  end if;

  -- ja existe Pessoa com este CPF na organizacao (ex.: cadastro manual ou
  -- importacao anterior, ainda sem conta) -- vincula em vez de duplicar.
  select id into v_existing
    from public.registration_contacts
    where organization_id = p_organization_id and cpf = v_cpf
    for update;

  if v_existing.id is not null then
    update public.registration_contacts set
      user_id = coalesce(user_id, p_user_id),
      full_name = coalesce(nullif(trim(full_name), ''), trim(v_profile.full_name)),
      birth_date = coalesce(birth_date, v_profile.birth_date),
      gender = coalesce(nullif(trim(coalesce(gender, '')), ''), nullif(trim(coalesce(v_profile.gender, '')), '')),
      phone = coalesce(nullif(trim(coalesce(phone, '')), ''), trim(v_profile.phone)),
      email = coalesce(nullif(trim(coalesce(email, '')), ''), lower(trim(v_email))),
      city = coalesce(nullif(trim(coalesce(city, '')), ''), nullif(trim(coalesce(v_profile.city, '')), '')),
      updated_at = now()
      where id = v_existing.id
      returning id into v_contact_id;
    return v_contact_id;
  end if;

  -- nenhuma Pessoa existente: cria uma nova, ja vinculada a conta.
  -- on conflict cobre a corrida entre duas chamadas concorrentes para o
  -- mesmo CPF (ex.: duas abas concluindo o cadastro ao mesmo tempo).
  insert into public.registration_contacts(
    organization_id, user_id, full_name, cpf, birth_date, gender, phone, email, city, created_by
  ) values (
    p_organization_id, p_user_id, trim(v_profile.full_name), v_cpf, v_profile.birth_date,
    nullif(trim(coalesce(v_profile.gender, '')), ''), trim(v_profile.phone), lower(trim(v_email)),
    nullif(trim(coalesce(v_profile.city, '')), ''), p_user_id
  )
  on conflict (organization_id, cpf) do update set
    user_id = coalesce(registration_contacts.user_id, excluded.user_id),
    updated_at = now()
  returning id into v_contact_id;

  return v_contact_id;
end;
$$;

ALTER FUNCTION "public"."ensure_registration_contact_for_user"("p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."ensure_registration_contact_for_user"("p_user_id" "uuid", "p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_registration_contact_for_user"("p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_registration_contact_for_user"("p_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";

-- Checagem pre-vinculo: "este CPF ja pertence a uma conta diferente?" --
-- chamavel por anon (roda em /criar-conta ANTES de auth.signUp criar a
-- conta) e por authenticated (roda em /primeiro-acesso, onde a conta ja
-- existe e precisa se excluir da propria checagem via p_exclude_user_id).
-- So devolve um booleano + a organizacao resolvida -- nunca nome/e-mail da
-- outra conta, pra nao vazar dado pessoal de terceiros no formulario.
CREATE OR REPLACE FUNCTION "public"."find_conflicting_registration_contact"(
  "p_cpf" "text",
  "p_exclude_user_id" "uuid" DEFAULT NULL::"uuid",
  "p_organization_id" "uuid" DEFAULT NULL::"uuid"
)
RETURNS TABLE("has_conflict" boolean, "organization_id" "uuid")
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
    organization_id := null;
    return next;
    return;
  end if;

  if v_org_id is null then
    v_org_id := public.resolve_default_registration_organization();
  end if;

  if v_org_id is null then
    has_conflict := false;
    organization_id := null;
    return next;
    return;
  end if;

  select id, user_id into v_existing
    from public.registration_contacts
    where organization_id = v_org_id and cpf = v_cpf;

  has_conflict := found and v_existing.user_id is not null and v_existing.user_id is distinct from p_exclude_user_id;
  organization_id := v_org_id;
  return next;
end;
$$;

ALTER FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_conflicting_registration_contact"("p_cpf" "text", "p_exclude_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";
