-- 101_filter_confirmed_history_in_import_finalization_preflight.sql
-- Estritamente somente leitura. Valida a definicao ativa e o impacto global
-- antes da migration 101 filtrar a evidencia de lote por status confirmed.

with
expected_text as (
  select
    $expected$where ph.participant_id=p_participant_id and ph.source='import';$expected$::text
      as source_predicate,
    $installed$where ph.participant_id=p_participant_id and ph.source='import' and ph.status='confirmed';$installed$::text
      as confirmed_predicate
),
function_state as (
  select to_regprocedure(
    'public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)'
  ) as signature
),
active_definition as (
  select
    fs.signature,
    case when fs.signature is null then null else pg_get_functiondef(fs.signature) end
      as definition
  from function_state fs
),
function_checks as (
  select
    ad.signature is not null as has_expected_function_signature,
    coalesce(position(
      'ifv_actorisdistinctfromv_participant.user_idandnotpublic.user_can_access_organization'
      in regexp_replace(lower(ad.definition),'\s+','','g')
    )>0,false) as has_owner_authorization_from_096,
    coalesce(position(et.confirmed_predicate in ad.definition)>0,false)
      as confirmed_filter_already_installed,
    coalesce(position(et.source_predicate in ad.definition)>0,false)
      as exact_source_predicate_is_replaceable
  from active_definition ad
  cross join expected_text et
),
participant_import_evidence as (
  select
    p.id as participant_id,
    p.event_id,
    count(distinct ib.id) as all_valid_batch_count,
    count(distinct ib.id) filter(where ph.status='confirmed')
      as confirmed_valid_batch_count,
    count(distinct ib.id) filter(where ph.status='duplicate')
      as duplicate_valid_batch_count,
    exists(
      select 1
      from public.participation_history duplicate_ph
      join public.import_batches duplicate_ib
        on duplicate_ib.id=duplicate_ph.import_batch_id
       and duplicate_ib.event_id=p.event_id
       and duplicate_ib.import_type='current_event_registrations'
      where duplicate_ph.participant_id=p.id
        and duplicate_ph.source='import'
        and duplicate_ph.status='duplicate'
        and not exists(
          select 1
          from public.participation_history confirmed_ph
          where confirmed_ph.participant_id=p.id
            and confirmed_ph.source='import'
            and confirmed_ph.status='confirmed'
            and confirmed_ph.import_batch_id=duplicate_ph.import_batch_id
        )
    ) as has_duplicate_only_extra_batch,
    bool_or(
      ph.status='confirmed'
      and (
        ph.event_id is distinct from p.event_id
        or ph.import_batch_id is null
        or ib.id is null
      )
    ) as has_invalid_confirmed_batch_evidence
  from public.participants p
  join public.participation_history ph
    on ph.participant_id=p.id
   and ph.source='import'
  left join public.import_batches ib
    on ib.id=ph.import_batch_id
   and ib.event_id=p.event_id
   and ib.import_type='current_event_registrations'
  group by p.id,p.event_id
),
impact as (
  select
    count(*) filter(
      where pie.all_valid_batch_count is distinct from pie.confirmed_valid_batch_count
    )::integer as affected_participant_count,
    count(*) filter(where pie.confirmed_valid_batch_count>1)::integer
      as participants_with_multiple_confirmed_batches,
    count(*) filter(where pie.confirmed_valid_batch_count=0)::integer
      as participants_without_confirmed_batch,
    count(*) filter(where pie.has_duplicate_only_extra_batch)::integer
      as participants_with_duplicate_only_extra_batches,
    count(*) filter(
      where pie.has_invalid_confirmed_batch_evidence
    )::integer as structurally_ambiguous_participant_count,
    count(*) filter(
      where pie.all_valid_batch_count is distinct from pie.confirmed_valid_batch_count
        and pie.confirmed_valid_batch_count>1
    )::integer as affected_participants_with_multiple_confirmed_batches,
    count(*) filter(
      where pie.all_valid_batch_count is distinct from pie.confirmed_valid_batch_count
        and pie.confirmed_valid_batch_count=0
    )::integer as affected_participants_without_confirmed_batch,
    count(*) filter(
      where pie.all_valid_batch_count is distinct from pie.confirmed_valid_batch_count
        and pie.has_invalid_confirmed_batch_evidence
    )::integer as affected_structurally_ambiguous_participant_count,
    coalesce(
      bool_and(pie.all_valid_batch_count>1)
        filter(where pie.confirmed_valid_batch_count>1),
      true
    ) as preserves_preexisting_confirmed_ambiguity
  from participant_import_evidence pie
)
select
  fc.has_expected_function_signature,
  fc.has_owner_authorization_from_096,
  fc.confirmed_filter_already_installed,
  fc.exact_source_predicate_is_replaceable,
  i.affected_participant_count,
  i.participants_with_multiple_confirmed_batches,
  i.participants_without_confirmed_batch,
  i.participants_with_duplicate_only_extra_batches,
  i.structurally_ambiguous_participant_count,
  i.affected_participants_with_multiple_confirmed_batches,
  i.affected_participants_without_confirmed_batch,
  i.affected_structurally_ambiguous_participant_count,
  i.preserves_preexisting_confirmed_ambiguity,
  fc.has_expected_function_signature
    and fc.has_owner_authorization_from_096
    and (
      fc.confirmed_filter_already_installed
      or fc.exact_source_predicate_is_replaceable
    )
    and i.affected_participants_without_confirmed_batch=0
    and i.affected_structurally_ambiguous_participant_count=0
    and i.preserves_preexisting_confirmed_ambiguity
    as safe_to_apply
from function_checks fc
cross join impact i;
