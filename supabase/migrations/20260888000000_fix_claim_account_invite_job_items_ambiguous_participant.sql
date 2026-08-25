-- Corrige a ambiguidade entre a coluna da CTE claimed e o parametro de saida
-- participant_id criado implicitamente por RETURNS TABLE. A migration 87 ja
-- foi aplicada; somente a RPC afetada e substituida.

create or replace function public.claim_account_invite_job_items(
  p_job_id uuid,
  p_limit integer default 25
)
returns table(item_id uuid,participant_id uuid)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
#variable_conflict error
begin
  if auth.uid() is null
    or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao.';
  end if;

  if not exists(
    select 1
    from public.account_invite_jobs as job_access
    where job_access.id=p_job_id
      and public.user_can_access_organization(auth.uid(),job_access.organization_id)
  ) then
    raise exception 'Job invalido ou sem acesso.';
  end if;

  update public.account_invite_job_items as stale_item
  set status='pending',
      claimed_at=null,
      updated_at=now()
  where stale_item.job_id=p_job_id
    and stale_item.status='processing'
    and stale_item.claimed_at<now()-interval '10 minutes';

  update public.account_invite_jobs as active_job
  set status='processing',
      started_at=coalesce(active_job.started_at,now()),
      updated_at=now()
  where active_job.id=p_job_id
    and active_job.status='pending';

  return query
  with picked as (
    select candidate_item.id as picked_item_id
    from public.account_invite_job_items as candidate_item
    where candidate_item.job_id=p_job_id
      and candidate_item.status='pending'
    order by candidate_item.created_at,candidate_item.id
    for update of candidate_item skip locked
    limit least(greatest(coalesce(p_limit,25),1),25)
  ), claimed as (
    update public.account_invite_job_items as claimed_item
    set status='processing',
        attempt_count=claimed_item.attempt_count+1,
        claimed_at=now(),
        updated_at=now()
    from picked as picked_item
    where claimed_item.id=picked_item.picked_item_id
    returning claimed_item.id as claimed_item_id,
              claimed_item.participant_id as claimed_participant_id
  )
  select claimed_result.claimed_item_id,
         claimed_result.claimed_participant_id
  from claimed as claimed_result;
end
$$;

revoke all on function public.claim_account_invite_job_items(uuid,integer)
  from public,anon;
grant execute on function public.claim_account_invite_job_items(uuid,integer)
  to authenticated;
