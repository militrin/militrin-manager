-- 101_finalize_imported_participant_history_status_diagnostic.sql
-- Somente leitura: estado do convite 08b64aba... e auditoria das funcoes ativas
-- que consultam participation_history.

with
target_invite as (
  select
    pai.id as invite_id,
    pai.status as invite_status,
    pai.participant_id,
    pai.event_id,
    pai.auth_user_id,
    pai.claimed_user_id,
    p.user_id as participant_user_id
  from public.participant_account_invites pai
  join public.participants p on p.id=pai.participant_id
  where pai.id='08b64aba-76f3-446e-bf84-0107055f568b'::uuid
),
history_state as (
  select
    ph.id as history_id,
    ph.status,
    ph.source,
    ph.import_batch_id,
    ph.user_id,
    ph.participant_id,
    ph.event_id,
    ph.created_at,
    ph.updated_at
  from target_invite ti
  join public.participation_history ph
    on ph.participant_id=ti.participant_id
   and ph.event_id=ti.event_id
  order by ph.created_at,ph.id
),
active_functions as (
  select
    p.oid::regprocedure::text as function_signature,
    pg_get_functiondef(p.oid) as function_definition
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and position('participation_history' in lower(pg_get_functiondef(p.oid)))>0
),
function_audit as (
  select
    af.function_signature,
    af.function_signature like 'finalize_imported_participant_after_issue_resolution(%'
      as is_finalization_function,
    position('source=''import''' in regexp_replace(lower(af.function_definition),'\s+','','g'))>0
      as filters_import_source,
    lower(af.function_definition) ~ 'ph\.status\s*=\s*''confirmed'''
      as filters_confirmed_status,
    lower(af.function_definition) ~ 'ph\.status\s*<>\s*''duplicate'''
      as explicitly_excludes_duplicate_status,
    position('count(distinct ib.id)' in regexp_replace(lower(af.function_definition),'\s+',' ','g'))>0
      as counts_distinct_import_batches,
    af.function_definition
  from active_functions af
),
finalization as (
  select *
  from function_audit
  where is_finalization_function
),
batch_evidence as (
  select
    count(distinct ib.id)::integer as batches_including_all_import_statuses,
    array_agg(distinct ib.id order by ib.id) as batch_ids_including_all_import_statuses,
    count(distinct ib.id) filter(where ph.status='confirmed')::integer
      as batches_from_confirmed_only,
    array_agg(distinct ib.id order by ib.id) filter(where ph.status='confirmed')
      as batch_ids_from_confirmed_only,
    count(distinct ib.id) filter(where ph.status='duplicate')::integer
      as batches_from_duplicate_only,
    array_agg(distinct ib.id order by ib.id) filter(where ph.status='duplicate')
      as batch_ids_from_duplicate_only
  from target_invite ti
  join public.participation_history ph
    on ph.participant_id=ti.participant_id
   and ph.event_id=ti.event_id
   and ph.source='import'
  join public.import_batches ib
    on ib.id=ph.import_batch_id
   and ib.event_id=ti.event_id
   and ib.import_type='current_event_registrations'
)
select
  (select row_to_json(ti) from target_invite ti) as invite_and_participant,
  (select coalesce(jsonb_agg(to_jsonb(hs) order by hs.created_at,hs.history_id),'[]'::jsonb)
    from history_state hs) as participation_histories,
  (select row_to_json(be) from batch_evidence be) as batch_evidence,
  (select coalesce(jsonb_agg(jsonb_build_object(
      'function_signature',fa.function_signature,
      'is_finalization_function',fa.is_finalization_function,
      'filters_import_source',fa.filters_import_source,
      'filters_confirmed_status',fa.filters_confirmed_status,
      'explicitly_excludes_duplicate_status',fa.explicitly_excludes_duplicate_status,
      'counts_distinct_import_batches',fa.counts_distinct_import_batches
    ) order by fa.function_signature),'[]'::jsonb)
    from function_audit fa) as active_participation_history_function_audit,
  (select f.function_definition from finalization f limit 1) as active_finalization_definition,
  coalesce((select
    f.counts_distinct_import_batches
      and f.filters_import_source
      and not f.filters_confirmed_status
      and not f.explicitly_excludes_duplicate_status
    from finalization f limit 1),false)
    and (select batches_including_all_import_statuses>1
           and batches_from_confirmed_only=1
         from batch_evidence)
    as error_caused_by_duplicate_status_in_batch_count;
