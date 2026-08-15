-- 102_participant_portal_access_policy_diagnostic.sql
-- Somente leitura: perfil e bloqueios operacionais do usuario de primeiro acesso.

with
target_user as (
  select '549aac1f-84b0-42ca-b89b-62d0ead8627d'::uuid as user_id
),
profile_state as (
  select
    cp.user_id,
    cp.account_status,
    cp.must_change_password,
    cp.must_complete_profile,
    array_remove(array[
      case when nullif(trim(coalesce(cp.full_name,'')),'') is null then 'full_name' end,
      case when not public.is_valid_cpf(cp.cpf) then 'cpf' end,
      case when cp.birth_date is null then 'birth_date' end,
      case when length(regexp_replace(coalesce(cp.phone,''),'\D','','g'))<10 then 'phone' end,
      case when nullif(trim(coalesce(cp.city,'')),'') is null then 'city' end,
      case when au.email is null or au.email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then 'email' end
    ],null) as missing_required_fields
  from target_user tu
  left join public.customer_profiles cp on cp.user_id=tu.user_id
  left join auth.users au on au.id=tu.user_id
),
owned_participants as (
  select p.id
  from target_user tu
  join public.participants p on p.user_id=tu.user_id
),
open_issues as (
  select pdi.*
  from owned_participants op
  join public.participant_data_issues pdi on pdi.participant_id=op.id
  where pdi.status='open'
),
scope_counts as (
  select coalesce(jsonb_object_agg(resolution_scope,issue_count),'{}'::jsonb) as issues_by_resolution_scope
  from (
    select coalesce(nullif(trim(resolution_scope),''),'unspecified') as resolution_scope,count(*)::integer as issue_count
    from open_issues
    group by coalesce(nullif(trim(resolution_scope),''),'unspecified')
  ) grouped
),
block_counts as (
  select
    count(*) filter(where blocks_payment)::integer as blocks_payment_count,
    count(*) filter(where blocks_ticket_issuance)::integer as blocks_ticket_issuance_count,
    count(*) filter(where blocks_checkin)::integer as blocks_checkin_count,
    count(*) filter(where blocks_kit_delivery)::integer as blocks_kit_delivery_count,
    count(*) filter(where resolution_scope='user_resolvable')::integer as user_resolvable_open_count,
    count(*) filter(where resolution_scope is distinct from 'user_resolvable')::integer as administrative_open_count
  from open_issues
)
select
  ps.user_id,
  ps.account_status,
  ps.must_change_password,
  ps.must_complete_profile,
  ps.missing_required_fields,
  ps.account_status='blocked' as first_access_is_blocked,
  ps.account_status is distinct from 'blocked'
    and (
      coalesce(ps.must_change_password,false)
      or coalesce(ps.must_complete_profile,false)
      or cardinality(coalesce(ps.missing_required_fields,'{}'::text[]))>0
    ) as first_access_required,
  sc.issues_by_resolution_scope,
  bc.blocks_payment_count,
  bc.blocks_ticket_issuance_count,
  bc.blocks_checkin_count,
  bc.blocks_kit_delivery_count,
  bc.user_resolvable_open_count,
  bc.administrative_open_count,
  case
    when ps.account_status='blocked' then 'src/app/minha-conta/layout.tsx: explicit account block'
    else 'src/app/painel/layout.tsx: administrative permission guard'
  end as expected_access_denied_origin
from profile_state ps
cross join scope_counts sc
cross join block_counts bc;
