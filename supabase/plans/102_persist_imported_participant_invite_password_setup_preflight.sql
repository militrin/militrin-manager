-- 102_persist_imported_participant_invite_password_setup_preflight.sql
-- Estritamente somente leitura: estrutura e estados afetados pela migration 102.

with
structure as (
  select
    to_regclass('public.participant_account_invites') is not null as has_invite_table,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_account_invites' and column_name='auth_user_id' and data_type='uuid') as has_auth_user_id,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_account_invites' and column_name='requires_password_setup' and data_type='boolean') as requires_password_setup_already_installed,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_account_invites' and column_name='password_setup_completed_at' and data_type='timestamp with time zone') as password_setup_completed_at_already_installed,
    to_regprocedure('public.prepare_participant_account_invite(uuid)') is not null as has_prepare_function,
    to_regprocedure('public.claim_participant_account_invite(uuid)') is not null as has_claim_function,
    to_regprocedure('public.check_participant_account_invite_eligibility(uuid)') is not null as has_eligibility_function
),
active_definitions as (
  select
    coalesce(pg_get_functiondef(to_regprocedure('public.prepare_participant_account_invite(uuid)')),'') as prepare_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.claim_participant_account_invite(uuid)')),'') as claim_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.check_participant_account_invite_eligibility(uuid)')),'') as eligibility_definition
),
imported_invites as (
  select
    pai.id,pai.status,pai.auth_user_id,pai.claimed_user_id,pai.participant_id,
    p.user_id as participant_user_id,
    coalesce((to_jsonb(pai)->>'requires_password_setup')::boolean,false) as requires_password_setup,
    nullif(to_jsonb(pai)->>'password_setup_completed_at','') is not null as password_setup_completed
  from public.participant_account_invites pai
  left join public.participants p
    on p.id=pai.participant_id and p.event_id=pai.event_id
  where (pai.status='claimed' or (pai.status='pending' and pai.expires_at>now()))
    and exists(
      select 1 from public.participation_history ph
      where ph.participant_id=pai.participant_id
        and ph.event_id=pai.event_id
        and ph.source='import'
    )
),
impact as (
  select
    count(*) filter(where status='pending')::integer as imported_pending_invite_count,
    count(*) filter(where status='claimed')::integer as imported_claimed_invite_count,
    count(*) filter(where status='pending' and not password_setup_completed)::integer as pending_invites_requiring_password_setup_count,
    count(*) filter(where status='claimed' and not password_setup_completed)::integer as claimed_invites_requiring_explicit_password_setup_count,
    count(*) filter(where password_setup_completed)::integer as existing_explicit_completion_count,
    count(*) filter(where password_setup_completed and not requires_password_setup)::integer as invalid_completion_state_count,
    count(*) filter(where status='claimed' and (
      auth_user_id is null
      or claimed_user_id is distinct from auth_user_id
      or participant_user_id is distinct from auth_user_id
    ))::integer as structurally_ambiguous_claimed_invite_count
  from imported_invites
),
function_audit as (
  select
    position(
      'encrypted_password'
      in lower(ad.prepare_definition || E'\n' || ad.claim_definition || E'\n' || ad.eligibility_definition)
    )>0 as active_database_functions_read_encrypted_password,
    position('encrypted_password' in lower(ad.prepare_definition || E'\n' || ad.claim_definition))>0
      as non_eligibility_functions_read_encrypted_password,
    position('ifnullif(v_auth_user.encrypted_password,'''')isnullthen' in regexp_replace(lower(ad.eligibility_definition),'\s+','','g'))>0
      as active_legacy_password_classification_detected,
    (
      position('current_user_has_permission(''participants.edit_basic'')' in regexp_replace(lower(ad.eligibility_definition),'\s+','','g'))>0
      and position('user_can_access_organization(v_actor,v_p.organization_id)' in regexp_replace(lower(ad.eligibility_definition),'\s+','','g'))>0
      and position('participant_invite_id' in lower(ad.eligibility_definition))>0
      and position('v_conflicting_participants>0' in regexp_replace(lower(ad.eligibility_definition),'\s+','','g'))>0
      and position('v_profile_cpf<>' in regexp_replace(lower(ad.eligibility_definition),'\s+','','g'))>0
      and position('''already_linked''' in lower(ad.eligibility_definition))>0
      and position('''account_conflict''' in lower(ad.eligibility_definition))>0
      and position(
        'ifnullif(v_auth_user.encrypted_password,'''')isnullthenreturnqueryselecttrue,''resend_invite_password_required'',''convitepodeserreenviadoparaconcluiroprimeiroacesso.'',v_email;elsereturnqueryselecttrue,''resend_invite_existing_account'',''contaexistentevalidadapeloconvite;enviaracessoseguroparareivindicarocadastro.'',v_email;endif;'
        in regexp_replace(lower(ad.eligibility_definition),'\s+','','g')
      )>0
    ) as eligibility_body_matches_expected_099,
    position('ph.source=''import''' in regexp_replace(lower(ad.eligibility_definition),'\s+','','g'))>0
      and position('encrypted_password' in lower(ad.eligibility_definition))=0
      as eligibility_102_classification_installed
  from active_definitions ad
)
select
  s.has_invite_table,
  s.has_auth_user_id,
  s.requires_password_setup_already_installed,
  s.password_setup_completed_at_already_installed,
  s.has_prepare_function,
  s.has_claim_function,
  s.has_eligibility_function,
  position('check_participant_account_invite_eligibility' in ad.prepare_definition)>0 as prepare_uses_canonical_eligibility,
  position('auth_user_id is distinct from v_actor' in lower(ad.claim_definition))>0 as claim_requires_explicit_auth_correlation,
  fa.active_database_functions_read_encrypted_password,
  fa.non_eligibility_functions_read_encrypted_password,
  fa.active_legacy_password_classification_detected,
  fa.eligibility_body_matches_expected_099,
  fa.eligibility_102_classification_installed,
  i.imported_pending_invite_count,
  i.imported_claimed_invite_count,
  i.pending_invites_requiring_password_setup_count,
  i.claimed_invites_requiring_explicit_password_setup_count,
  i.existing_explicit_completion_count,
  i.invalid_completion_state_count,
  i.invalid_completion_state_count>0 as has_invalid_completion_state,
  i.structurally_ambiguous_claimed_invite_count,
  s.has_invite_table
    and s.has_auth_user_id
    and s.has_prepare_function
    and s.has_claim_function
    and s.has_eligibility_function
    and position('check_participant_account_invite_eligibility' in ad.prepare_definition)>0
    and position('auth_user_id is distinct from v_actor' in lower(ad.claim_definition))>0
    and i.structurally_ambiguous_claimed_invite_count=0
    and i.invalid_completion_state_count=0
    and not fa.non_eligibility_functions_read_encrypted_password
    and (
      (fa.active_legacy_password_classification_detected and fa.eligibility_body_matches_expected_099)
      or fa.eligibility_102_classification_installed
    )
    as safe_to_apply
from structure s
cross join active_definitions ad
cross join impact i
cross join function_audit fa;
