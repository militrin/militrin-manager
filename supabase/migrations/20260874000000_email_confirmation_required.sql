-- ============================================================================
-- Pacote de autenticacao: confirmacao de e-mail obrigatoria.
--
-- DECISAO (item 9 do pedido): materializar registration_contact SOMENTE
-- depois que o e-mail estiver confirmado. Motivo: uma conta cujo e-mail
-- nunca foi confirmado pode nem pertencer a quem digitou aquele endereco
-- (erro de digitacao, e-mail de terceiro) -- materializar a Pessoa antes
-- disso arriscaria criar um Cadastro global "fantasma" vinculado a uma
-- identidade nao verificada. Preferimos "materializar cedo, mas marcar
-- conta como nao validada" (opcao B do pedido original) SO se ja houvesse
-- uma dependencia forte de outra parte do sistema em ter o
-- registration_contact disponivel antes da confirmacao -- nao ha (auditado:
-- nenhum RPC/tela depende de registration_contact existir antes do primeiro
-- login pos-confirmacao). Consistente com o schema atual: e so mais uma
-- precondicao no MESMO padrao ja usado (cpf/nome/nascimento/telefone/email
-- ausentes -> retorna null, nunca levanta excecao por dado incompleto).
--
-- ensure_registration_contact_for_user ja e chamada, hoje, exatamente nos
-- pontos certos para isso funcionar sozinho: toda vez que uma sessao e
-- estabelecida (signup com sessao imediata, login, refresh de sessao) --
-- entao assim que o usuario confirma o e-mail e loga pela primeira vez, a
-- materializacao acontece automaticamente, sem precisar de um terceiro
-- caminho de codigo novo.
-- ============================================================================

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
  v_email_confirmed_at timestamptz;
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

  select email, email_confirmed_at into v_email, v_email_confirmed_at from auth.users where id = p_user_id;
  v_cpf := regexp_replace(coalesce(v_profile.cpf, ''), '\D', '', 'g');

  if length(v_cpf) <> 11
     or nullif(trim(coalesce(v_profile.full_name, '')), '') is null
     or v_profile.birth_date is null
     or nullif(trim(coalesce(v_profile.phone, '')), '') is null
     or nullif(trim(coalesce(v_email, '')), '') is null
     or v_email_confirmed_at is null
  then
    return null;
  end if;

  if p_organization_id is null then
    p_organization_id := public.resolve_default_registration_organization();
    if p_organization_id is null then
      return null;
    end if;
  end if;

  if (select fc.has_conflict from public.find_conflicting_registration_contact(v_cpf, p_user_id, p_organization_id) fc) then
    raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
      detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
  end if;

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

-- ============================================================================
-- Suporte a "trocar e-mail antes da confirmacao" (item 9 do pedido de
-- autenticacao): a conta ainda nao tem sessao (Supabase recusa login antes
-- de confirmar), entao a troca de e-mail so pode ser feita via Admin API
-- (service_role), depois de confirmar a senha via signInWithPassword (que
-- retorna 'email_not_confirmed' quando a senha esta correta -- prova de
-- posse sem precisar de sessao). Isso exige localizar o user_id pelo
-- e-mail antigo/novo em auth.users, schema que a REST API nao expoe --
-- dai esta funcao pontual, restrita a service_role.
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."find_auth_user_id_by_email"("p_email" "text")
RETURNS "uuid"
LANGUAGE "sql" SECURITY DEFINER
SET "search_path" TO 'public', 'pg_temp'
AS $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;

ALTER FUNCTION "public"."find_auth_user_id_by_email"("p_email" "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."find_auth_user_id_by_email"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."find_auth_user_id_by_email"("p_email" "text") TO "service_role";
