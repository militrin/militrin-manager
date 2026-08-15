-- 100_reconcile_participation_history_on_invite_claim_preflight.sql
-- Estritamente somente leitura. Retorna um resumo global e o diagnostico de
-- todos os convites pending sem expor e-mail, CPF, nome ou tokens.

with
structural_checks as (
  select
    to_regclass('public.ux_participation_history_user_event_confirmed') is not null
      as has_confirmed_user_event_unique_index,
    exists(
      select 1
      from information_schema.columns c
      where c.table_schema='public'
        and c.table_name='participant_account_invites'
        and c.column_name='auth_user_id'
        and c.data_type='uuid'
    ) as has_invite_auth_user_id_column
),
pending_invites as (
  select
    pai.id as invite_id,
    pai.participant_id,
    pai.event_id as invite_event_id,
    nullif(to_jsonb(pai)->>'auth_user_id','')::uuid as actor_user_id,
    p.event_id as participant_event_id,
    p.user_id as participant_user_id
  from public.participant_account_invites pai
  left join public.participants p on p.id=pai.participant_id
  where pai.status='pending'
),
invite_facts as (
  select
    pi.*,
    exists(select 1 from auth.users au where au.id=pi.actor_user_id) as actor_user_exists,
    coalesce(ph.confirmed_history_count,0)::integer as confirmed_history_count,
    ph.participant_confirmed_ids,
    ph.oldest_participant_confirmed_id,
    coalesce(ph.other_user_history_count,0)::integer as other_user_history_count,
    coalesce(actor_ph.actor_confirmed_count,0)::integer as actor_confirmed_count,
    actor_ph.actor_confirmed_id,
    actor_ph.actor_confirmed_participant_id,
    case
      when coalesce(actor_ph.actor_confirmed_count,0)=1
        and actor_ph.actor_confirmed_participant_id is not distinct from pi.participant_id
        then actor_ph.actor_confirmed_id
      when coalesce(actor_ph.actor_confirmed_count,0)=0
        then ph.oldest_participant_confirmed_id
      else null
    end as canonical_history_id
  from pending_invites pi
  left join lateral (
    select
      count(*) filter(where h.status='confirmed') as confirmed_history_count,
      array_agg(h.id order by h.created_at,h.id)
        filter(where h.status='confirmed') as participant_confirmed_ids,
      (array_agg(h.id order by h.created_at,h.id)
        filter(where h.status='confirmed'))[1] as oldest_participant_confirmed_id,
      count(*) filter(
        where h.user_id is not null and h.user_id<>pi.actor_user_id
      ) as other_user_history_count
    from public.participation_history h
    where h.participant_id=pi.participant_id
      and h.event_id=pi.invite_event_id
  ) ph on true
  left join lateral (
    select
      count(*) as actor_confirmed_count,
      (array_agg(h.id order by h.created_at,h.id))[1] as actor_confirmed_id,
      (array_agg(h.participant_id order by h.created_at,h.id))[1]
        as actor_confirmed_participant_id
    from public.participation_history h
    where h.user_id=pi.actor_user_id
      and h.event_id=pi.invite_event_id
      and h.status='confirmed'
  ) actor_ph on true
),
classified as (
  select
    f.*,
    case
      when not sc.has_confirmed_user_event_unique_index
        or not sc.has_invite_auth_user_id_column
        then 'blocked_structural'
      when f.actor_user_id is null or not f.actor_user_exists
        then 'blocked_missing_explicit_auth_correlation'
      when f.participant_event_id is null
        or f.participant_event_id is distinct from f.invite_event_id
        then 'blocked_event_mismatch'
      when f.participant_user_id is not null
        and f.participant_user_id<>f.actor_user_id
        then 'blocked_participant_owned_by_other_user'
      when f.other_user_history_count>0
        then 'blocked_history_owned_by_other_user'
      when f.actor_confirmed_count>1
        then 'ambiguous_multiple_actor_confirmed_histories'
      when f.actor_confirmed_count=1
        and f.actor_confirmed_participant_id is not null
        and f.actor_confirmed_participant_id<>f.participant_id
        then 'blocked_actor_confirmed_for_other_participant'
      when f.canonical_history_id is null and f.confirmed_history_count>0
        then 'ambiguous_canonical_history'
      else 'safe'
    end as classification,
    case
      when f.canonical_history_id is null then '{}'::uuid[]
      else coalesce(array(
        select history_id
        from unnest(coalesce(f.participant_confirmed_ids,'{}'::uuid[])) history_id
        where history_id<>f.canonical_history_id
        order by history_id
      ),'{}'::uuid[])
    end as histories_to_mark_duplicate
  from invite_facts f
  cross join structural_checks sc
),
summary as (
  select
    sc.has_confirmed_user_event_unique_index,
    sc.has_invite_auth_user_id_column,
    count(c.invite_id)::integer as pending_invite_count,
    count(*) filter(where c.classification='safe')::integer as safe_invite_count,
    count(*) filter(where c.classification like 'ambiguous_%')::integer as ambiguous_invite_count,
    count(*) filter(where c.classification like 'blocked_%')::integer as blocked_invite_count,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'invite_id',c.invite_id,
          'participant_id',c.participant_id,
          'invite_event_id',c.invite_event_id,
          'participant_event_id',c.participant_event_id,
          'actor_user_id',c.actor_user_id,
          'explicit_auth_correlation',c.actor_user_id is not null and c.actor_user_exists,
          'participant_user_id',c.participant_user_id,
          'other_user_history_count',c.other_user_history_count,
          'actor_confirmed_count',c.actor_confirmed_count,
          'actor_confirmed_participant_id',c.actor_confirmed_participant_id,
          'confirmed_history_count',c.confirmed_history_count,
          'canonical_history_id',c.canonical_history_id,
          'histories_to_mark_duplicate',c.histories_to_mark_duplicate,
          'classification',c.classification
        ) order by c.invite_id
      ) filter(where c.invite_id is not null),
      '[]'::jsonb
    ) as pending_invites
  from structural_checks sc
  left join classified c on true
  group by sc.has_confirmed_user_event_unique_index,sc.has_invite_auth_user_id_column
)
select
  has_confirmed_user_event_unique_index,
  has_invite_auth_user_id_column,
  pending_invite_count,
  safe_invite_count,
  ambiguous_invite_count,
  blocked_invite_count,
  pending_invites,
  has_confirmed_user_event_unique_index
    and has_invite_auth_user_id_column
    and ambiguous_invite_count=0
    and blocked_invite_count=0
    as safe_to_apply
from summary;
