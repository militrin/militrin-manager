-- 093_ambiguous_participant_user_link_diagnostic.sql
-- Diagnostico estritamente somente leitura dos cinco participants conhecidos.
-- O SQL corretivo e retornado apenas como texto e nunca e executado por este arquivo.

-- 1. Classificacao individual e evidencia minima de origem.
with target(participant_id) as (values
  ('b2b4b9f2-1cab-452a-b76d-5380e631e348'::uuid),
  ('97373a23-b75f-499f-9e0e-a73ba56aeb17'::uuid),
  ('536f32ef-b9bc-45f2-ab57-3112f2aee631'::uuid),
  ('4a8914a6-a1d5-4554-9bd2-102dbd1b5049'::uuid),
  ('2990d242-7f3c-4c96-b4ab-887980038dd6'::uuid)
), evidence as (
  select
    p.id as participant_id,
    p.full_name as participant_name,
    cp.full_name as profile_name,
    p.user_id,
    p.event_id,
    imported.import_batch_id,
    imported.imported_by,
    lower(trim(p.full_name)) = lower(trim(cp.full_name)) as name_matches_profile
  from target t
  join public.participants p on p.id = t.participant_id
  left join public.customer_profiles cp on cp.user_id = p.user_id
  left join lateral (
    select ph.import_batch_id, ib.imported_by
    from public.participation_history ph
    join public.import_batches ib on ib.id = ph.import_batch_id
    where ph.participant_id = p.id
      and ph.event_id = p.event_id
      and ph.source = 'import'
      and ph.import_batch_id is not null
      and ib.event_id = p.event_id
      and ib.imported_by = p.user_id
    order by ph.import_batch_id::text
    limit 1
  ) imported on true
), classified as (
  select
    participant_id,
    participant_name,
    profile_name,
    user_id,
    event_id,
    import_batch_id,
    imported_by,
    case
      when user_id = 'e8f5777b-3ed1-409d-b3f1-71724be5a09e'::uuid
        and event_id = '6c931940-03ad-48c2-836c-754924a00d00'::uuid
        and name_matches_profile
        then 'legitimate_account_link'
      when user_id = 'e8f5777b-3ed1-409d-b3f1-71724be5a09e'::uuid
        and event_id = '6c931940-03ad-48c2-836c-754924a00d00'::uuid
        and name_matches_profile is false
        and import_batch_id is not null
        and imported_by = user_id
        then 'legacy_import_operator_link'
      else 'inconclusive'
    end as classification,
    case
      when user_id = 'e8f5777b-3ed1-409d-b3f1-71724be5a09e'::uuid
        and event_id = '6c931940-03ad-48c2-836c-754924a00d00'::uuid
        and name_matches_profile
        then 'Participant name matches the customer profile linked by the same user_id; any import evidence belongs to that same participant name.'
      when user_id = 'e8f5777b-3ed1-409d-b3f1-71724be5a09e'::uuid
        and event_id = '6c931940-03ad-48c2-836c-754924a00d00'::uuid
        and name_matches_profile is false
        and import_batch_id is not null
        and imported_by = user_id
        then 'Participant name differs from the linked profile and participation history points to an import batch for the same event executed by the assigned user.'
      else 'Required account-link or import-operator evidence is missing or inconsistent.'
    end as reason
  from evidence
)
select
  participant_id,
  participant_name,
  profile_name,
  user_id,
  event_id,
  import_batch_id,
  imported_by,
  classification,
  reason
from classified
order by participant_name, participant_id;

-- 2. Resumo e SQL corretivo somente como texto.
with target(participant_id) as (values
  ('b2b4b9f2-1cab-452a-b76d-5380e631e348'::uuid),
  ('97373a23-b75f-499f-9e0e-a73ba56aeb17'::uuid),
  ('536f32ef-b9bc-45f2-ab57-3112f2aee631'::uuid),
  ('4a8914a6-a1d5-4554-9bd2-102dbd1b5049'::uuid),
  ('2990d242-7f3c-4c96-b4ab-887980038dd6'::uuid)
), evidence as (
  select
    p.id as participant_id,
    p.user_id,
    p.event_id,
    lower(trim(p.full_name)) = lower(trim(cp.full_name)) as name_matches_profile,
    imported.import_batch_id,
    imported.imported_by
  from target t
  join public.participants p on p.id = t.participant_id
  left join public.customer_profiles cp on cp.user_id = p.user_id
  left join lateral (
    select ph.import_batch_id, ib.imported_by
    from public.participation_history ph
    join public.import_batches ib on ib.id = ph.import_batch_id
    where ph.participant_id = p.id
      and ph.event_id = p.event_id
      and ph.source = 'import'
      and ph.import_batch_id is not null
      and ib.event_id = p.event_id
      and ib.imported_by = p.user_id
    order by ph.import_batch_id::text
    limit 1
  ) imported on true
), classified as (
  select participant_id, case
    when user_id = 'e8f5777b-3ed1-409d-b3f1-71724be5a09e'::uuid
      and event_id = '6c931940-03ad-48c2-836c-754924a00d00'::uuid
      and name_matches_profile
      then 'legitimate_account_link'
    when user_id = 'e8f5777b-3ed1-409d-b3f1-71724be5a09e'::uuid
      and event_id = '6c931940-03ad-48c2-836c-754924a00d00'::uuid
      and name_matches_profile is false
      and import_batch_id is not null
      and imported_by = user_id
      then 'legacy_import_operator_link'
    else 'inconclusive'
  end as classification
  from evidence
), summary as (
  select
    count(*) filter (where classification = 'legitimate_account_link') as legitimate_account_link,
    count(*) filter (where classification = 'legacy_import_operator_link') as legacy_import_operator_link,
    count(*) filter (where classification = 'inconclusive') as inconclusive,
    coalesce(bool_and(
      classification = case
        when participant_id = 'b2b4b9f2-1cab-452a-b76d-5380e631e348'::uuid
          then 'legitimate_account_link'
        else 'legacy_import_operator_link'
      end
    ), false) as expected_mapping_matches
  from classified
), result as (
  select *,
    legitimate_account_link = 1
      and legacy_import_operator_link = 4
      and inconclusive = 0
      and expected_mapping_matches as safe_to_fix
  from summary
)
select
  legitimate_account_link,
  legacy_import_operator_link,
  inconclusive,
  safe_to_fix,
  case when safe_to_fix then
    'UPDATE public.participants SET user_id = NULL WHERE id IN (''97373a23-b75f-499f-9e0e-a73ba56aeb17''::uuid, ''536f32ef-b9bc-45f2-ab57-3112f2aee631''::uuid, ''4a8914a6-a1d5-4554-9bd2-102dbd1b5049''::uuid, ''2990d242-7f3c-4c96-b4ab-887980038dd6''::uuid) AND user_id = ''e8f5777b-3ed1-409d-b3f1-71724be5a09e''::uuid;'
  end as proposed_sql_not_executed
from result;
