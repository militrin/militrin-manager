-- ============================================================================
-- BUG: usuario promovido a equipe (admin_users ativo, com permissao valida)
-- via upsert_admin_user_access via botao "Painel administrativo" normalmente,
-- mas /painel quebra com 500 ("This page couldn't load / A server error
-- occurred").
--
-- CAUSA RAIZ (confirmada lendo o codigo e o estado real do banco, nao
-- suposta): admin_users NAO tem organization_id -- e uma tabela global,
-- "esta pessoa e' staff com esta funcao/permissoes", sem nenhum vinculo de
-- organizacao. Quem resolve QUAL organizacao um usuario administra e'
-- getCurrentOrganizationContext() (src/lib/organizations/current-organization.ts),
-- usada em praticamente toda pagina do /painel -- e ela chama o RPC
-- user_organization_ids, que e' 100% baseado em organization_members
-- (mais o caso especial de platform owner):
--   select om.organization_id from public.organization_members om
--   where om.user_id = p_user_id and om.is_active = true;
-- upsert_admin_user_access nunca escreveu em organization_members -- so em
-- admin_users/admin_user_permission_overrides. Confirmado no banco real: a
-- conta de teste promovida via "Adicionar membro" tem 1 linha em
-- admin_users (role Check-in, is_active=true) e ZERO linhas em
-- organization_members, enquanto o Owner tem as duas. Resultado:
-- canAccessAdministrativePanel() (baseada em resolve_user_permission, que
-- so olha admin_users -- correto, e' so "tem permissao?") retorna true e o
-- botao Painel aparece; o layout de /painel deixa entrar (mesma checagem);
-- mas loadAdminDashboard (src/lib/dashboard/admin-dashboard-data.ts:32) faz
--   const organization = (await getCurrentOrganizationContext()).organization;
--   if (!organization?.id) throw new Error('Organização não selecionada.');
-- -- um throw sem try/catch dentro de um Server Component, que o Next.js
-- transforma exatamente na tela generica "This page couldn't load / A
-- server error occurred". Owner nao quebra porque so ele tem linha em
-- organization_members (criada manualmente/na fundacao da organizacao).
--
-- DECISAO DE ARQUITETURA (pedida explicitamente, decidida apos auditar
-- getCurrentOrganizationContext -- nao e' vinculo paralelo, e' completar o
-- mesmo fluxo que ja faltava): admin_users continua sendo SOMENTE "tem
-- permissao" (global, sem organizacao) -- correto e nao muda.
-- organization_members continua sendo SOMENTE "em qual organizacao esta
-- pessoa opera" -- tambem nao muda. O que faltava e' upsert_admin_user_access
-- materializar as DUAS metades de "entrar pra equipe" numa unica chamada,
-- em vez de so a metade de permissao. Reusa resolve_default_registration_organization()
-- (20260873000000, mesmo helper ja usado por ensure_registration_contact_for_user
-- pra resolver "qual organizacao" quando so existe uma ativa) -- nenhuma
-- logica de resolucao de organizacao nova ou paralela. Se um dia existir
-- mais de 1 organizacao ativa, essa funcao retorna null e o upsert de
-- organization_members e' pulado silenciosamente (nunca adivinha) -- quem
-- chamar precisaria passar a organizacao explicitamente nesse cenario
-- futuro, mesma regra ja aplicada em ensure_registration_contact_for_user.
-- is_owner sempre false aqui -- esta RPC nunca concede "dono da
-- organizacao" (is_organization_owner), so acesso funcional; is_active
-- acompanha p_is_active, entao desativar alguem na equipe tambem desativa
-- o acesso a organizacao, nao so as permissoes.
-- ============================================================================

-- Corrige tambem quem ja tinha sido promovido antes desta migration. Sem
-- este backfill, apenas as proximas chamadas do RPC ganhariam o vinculo e a
-- conta que revelou o bug continuaria sem conseguir resolver o /painel.
-- O helper so retorna um id quando existe exatamente uma organizacao ativa;
-- em uma instalacao multi-organizacao nao fazemos nenhuma associacao por
-- suposicao. Vinculos existentes ficam intactos (inclusive is_owner/role_id).
insert into public.organization_members (
  organization_id,
  user_id,
  is_owner,
  is_active
)
select
  default_org.organization_id,
  au.user_id,
  false,
  au.is_active
from public.admin_users au
cross join lateral (
  select public.resolve_default_registration_organization() as organization_id
) default_org
where default_org.organization_id is not null
  and not exists (
    select 1
    from public.organization_members om
    where om.organization_id = default_org.organization_id
      and om.user_id = au.user_id
  );

CREATE OR REPLACE FUNCTION "public"."upsert_admin_user_access"("p_target_user_id" "uuid", "p_role_id" "uuid", "p_is_active" boolean DEFAULT true, "p_internal_note" "text" DEFAULT NULL::"text", "p_overrides" "jsonb" DEFAULT '[]'::"jsonb", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_user_id),
    'system'
  );
  v_actor_is_owner boolean := false;
  v_actor_can_edit_permissions boolean := false;
  v_actor_can_disable_user boolean := false;
  v_target_exists boolean := false;
  v_target_before_is_owner boolean := false;
  v_target_after_is_owner boolean := false;
  v_target_before_role_id uuid;
  v_target_before_active boolean := false;
  v_target_before_note text;
  v_role_code text;
  v_before_effective text[] := array[]::text[];
  v_after_effective text[] := array[]::text[];
  v_added text[] := array[]::text[];
  v_removed text[] := array[]::text[];
  v_invalid_override_count integer := 0;
  v_forbidden_grant text;
  v_default_organization_id uuid;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if p_target_user_id is null then
    raise exception 'Usuario alvo obrigatorio.';
  end if;

  v_actor_is_owner := public.is_active_owner(v_actor_user_id);
  v_actor_can_edit_permissions :=
    v_actor_is_owner
    or public.resolve_user_permission(v_actor_user_id, 'team.edit_permissions');
  v_actor_can_disable_user :=
    v_actor_is_owner
    or public.resolve_user_permission(v_actor_user_id, 'team.disable_user');

  if not v_actor_can_edit_permissions then
    raise exception 'Sem permissao para editar acessos da equipe.';
  end if;

  select exists (
    select 1
    from auth.users u
    where u.id = p_target_user_id
  )
  into v_target_exists;

  if not v_target_exists then
    raise exception 'Usuario alvo nao encontrado no Auth.';
  end if;

  select
    au.role_id,
    au.is_active,
    au.internal_note
  into
    v_target_before_role_id,
    v_target_before_active,
    v_target_before_note
  from public.admin_users au
  where au.user_id = p_target_user_id;

  v_target_before_is_owner := public.is_active_owner(p_target_user_id);

  if p_role_id is not null then
    select ar.code
    into v_role_code
    from public.admin_roles ar
    where ar.id = p_role_id
      and ar.is_active = true
    limit 1;

    if v_role_code is null then
      raise exception 'Funcao selecionada nao existe ou esta inativa.';
    end if;
  else
    v_role_code := null;
  end if;

  if v_target_before_is_owner and not v_actor_is_owner then
    raise exception 'Somente Owner pode editar outro Owner.';
  end if;

  if v_role_code = 'owner' and not v_actor_is_owner then
    raise exception 'Somente Owner pode promover usuario para Owner.';
  end if;

  if coalesce(p_is_active, true) = false and not v_actor_can_disable_user then
    raise exception 'Sem permissao para desativar usuario da equipe.';
  end if;

  select count(*)
  into v_invalid_override_count
  from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
  left join public.admin_permissions ap
    on ap.code = trim(coalesce(item ->> 'permission_code', ''))
   and ap.is_active = true
  where trim(coalesce(item ->> 'permission_code', '')) = ''
     or trim(coalesce(item ->> 'effect', '')) not in ('allow', 'deny')
     or ap.id is null;

  if v_invalid_override_count > 0 then
    raise exception 'Overrides invalidos: use permission_code valido e effect em allow/deny.';
  end if;

  if not v_actor_is_owner then
    with role_codes as (
      select p.code
      from public.admin_role_permissions arp
      join public.admin_permissions p
        on p.id = arp.permission_id
      where arp.role_id = p_role_id
        and p.is_active = true
    ),
    override_codes as (
      select
        trim(coalesce(item ->> 'permission_code', '')) as code,
        trim(coalesce(item ->> 'effect', '')) as effect
      from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
    ),
    denied as (
      select code
      from override_codes
      where effect = 'deny'
    ),
    allowed as (
      select code
      from override_codes
      where effect = 'allow'
    ),
    desired as (
      select code from role_codes
      union
      select code from allowed
      except
      select code from denied
    )
    select d.code
    into v_forbidden_grant
    from desired d
    where not public.resolve_user_permission(v_actor_user_id, d.code)
    limit 1;

    if v_forbidden_grant is not null then
      raise exception 'Voce nao pode conceder permissao que nao possui: %', v_forbidden_grant;
    end if;
  end if;

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
  into v_before_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  insert into public.admin_users (
    user_id,
    role_id,
    is_active,
    internal_note
  )
  values (
    p_target_user_id,
    p_role_id,
    coalesce(p_is_active, true),
    nullif(trim(coalesce(p_internal_note, '')), '')
  )
  on conflict (user_id)
  do update set
    role_id = excluded.role_id,
    is_active = excluded.is_active,
    internal_note = excluded.internal_note,
    updated_at = now();

  -- Metade que faltava: sem isto, a pessoa fica com permissao mas sem
  -- organizacao resolvida (ver auditoria completa no cabecalho desta
  -- migration) e qualquer pagina do /painel que dependa de
  -- getCurrentOrganizationContext() quebra com 500.
  v_default_organization_id := public.resolve_default_registration_organization();
  if v_default_organization_id is not null then
    insert into public.organization_members (organization_id, user_id, is_owner, is_active)
    values (v_default_organization_id, p_target_user_id, false, coalesce(p_is_active, true))
    on conflict (organization_id, user_id) do update set
      is_active = excluded.is_active,
      updated_at = now();
  end if;

  delete from public.admin_user_permission_overrides
  where user_id = p_target_user_id;

  insert into public.admin_user_permission_overrides (
    user_id,
    permission_id,
    effect
  )
  select
    p_target_user_id,
    ap.id,
    trim(item ->> 'effect')
  from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
  join public.admin_permissions ap
    on ap.code = trim(item ->> 'permission_code')
   and ap.is_active = true
  on conflict (user_id, permission_id)
  do update set
    effect = excluded.effect,
    updated_at = now();

  v_target_after_is_owner := public.is_active_owner(p_target_user_id);

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
  into v_after_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  select coalesce(array_agg(code order by code), array[]::text[])
  into v_added
  from (
    select unnest(v_after_effective)
    except
    select unnest(v_before_effective)
  ) t(code);

  select coalesce(array_agg(code order by code), array[]::text[])
  into v_removed
  from (
    select unnest(v_before_effective)
    except
    select unnest(v_after_effective)
  ) t(code);

  if to_regclass('public.audit_logs') is not null then
    insert into public.audit_logs (
      action,
      entity_type,
      entity_id,
      event_id,
      details
    )
    values (
      'admin_access_updated',
      'admin_users',
      p_target_user_id,
      null,
      jsonb_build_object(
        'actor_user_id', v_actor_user_id,
        'actor_email', v_actor_email,
        'target_user_id', p_target_user_id,
        'target_before_role_id', v_target_before_role_id,
        'target_after_role_id', p_role_id,
        'target_before_is_owner', v_target_before_is_owner,
        'target_after_is_owner', v_target_after_is_owner,
        'status_before', coalesce(v_target_before_active, false),
        'status_after', coalesce(p_is_active, true),
        'internal_note_before', v_target_before_note,
        'internal_note_after', nullif(trim(coalesce(p_internal_note, '')), ''),
        'organization_id', v_default_organization_id,
        'added_permissions', coalesce(v_added, array[]::text[]),
        'removed_permissions', coalesce(v_removed, array[]::text[]),
        'reason', nullif(trim(coalesce(p_reason, '')), '')
      )
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'target_user_id', p_target_user_id,
    'added_permissions', coalesce(v_added, array[]::text[]),
    'removed_permissions', coalesce(v_removed, array[]::text[])
  );
end;
$$;

ALTER FUNCTION "public"."upsert_admin_user_access"("p_target_user_id" "uuid", "p_role_id" "uuid", "p_is_active" boolean, "p_internal_note" "text", "p_overrides" "jsonb", "p_reason" "text") OWNER TO "postgres";
