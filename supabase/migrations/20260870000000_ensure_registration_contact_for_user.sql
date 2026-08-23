-- ============================================================================
-- Materializacao do Cadastro/Pessoa global (registration_contacts) para toda
-- conta que conclui o cadastro com dados pessoais suficientes.
-- ============================================================================
-- Bug: customer_profiles (global, por user_id) e registration_contacts (por
-- organizacao, fonte de /cadastros) so se conectavam via
-- trg_sync_participant_registration_contact, disparada em INSERT de
-- participants. Uma conta criada em /criar-conta ou finalizada em
-- /primeiro-acesso sem nunca ter comprado ingresso/se inscrito em evento
-- nunca gerava participants, entao nunca aparecia em /cadastros -- mesmo
-- com login funcionando normalmente.
--
-- registration_contacts nao tinha coluna para saber "este cadastro pertence
-- a esta conta"; so existia o vinculo indireto via participants.user_id.
-- Adicionamos user_id para permitir idempotencia (achar o cadastro ja
-- vinculado a conta) e para permitir vincular uma conta nova a uma Pessoa
-- que ja existia sem conta (ex.: cadastrada manualmente ou importada).
--
-- A deduplicacao usa a mesma regra canonica ja usada pelo projeto
-- (create_registration_contact / sync_participant_registration_contact):
-- unicidade por (organization_id, cpf). Nao adicionamos casamento por
-- e-mail porque, ao contrario do CPF, email nunca teve indice de unicidade
-- aqui -- duas pessoas diferentes (ex. familiares) podem compartilhar um
-- mesmo e-mail de contato, e casar por email arriscaria vincular a conta
-- de uma pessoa ao cadastro de outra.
--
-- Organizacao: hoje so existe uma organizacao ativa no sistema, entao a
-- funcao resolve isso automaticamente quando nenhuma organizacao e
-- informada. Se um dia existir mais de uma organizacao ativa, ela nao
-- adivinha -- simplesmente nao materializa (quem chamar precisa passar
-- p_organization_id explicitamente nesse cenario).
-- ============================================================================

ALTER TABLE public.registration_contacts
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_registration_contacts_org_user
  ON public.registration_contacts (organization_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_registration_contacts_user_id
  ON public.registration_contacts (user_id)
  WHERE user_id IS NOT NULL;

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
  v_org_ids uuid[];
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
    select array_agg(id) into v_org_ids
      from (select id from public.organizations where status = 'active' order by created_at asc limit 2) s;
    if coalesce(array_length(v_org_ids, 1), 0) <> 1 then
      return null;
    end if;
    p_organization_id := v_org_ids[1];
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

-- Backfill retroativo: regulariza contas ja criadas (inclusive antes desta
-- migration) que ficaram sem registration_contact. Idempotente -- seguro
-- de rodar de novo (on conflict + merge que so preenche lacunas).
SELECT public.ensure_registration_contact_for_user(cp.user_id)
FROM public.customer_profiles cp;
