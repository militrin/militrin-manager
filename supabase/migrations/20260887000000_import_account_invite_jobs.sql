-- Jobs persistentes de convite por importacao.
-- O envio continua no servidor Next.js pelo provedor Auth canonico; o banco
-- apenas resolve o lote, serializa trabalho e registra resultados.

create table public.account_invite_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  import_batch_id uuid not null references public.import_batches(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','processing','completed','completed_with_failures','cancelled')),
  total_count integer not null default 0,
  eligible_count integer not null default 0,
  processed_count integer not null default 0,
  sent_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index ux_account_invite_jobs_active_import
  on public.account_invite_jobs(import_batch_id)
  where status in ('pending','processing');

create table public.account_invite_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.account_invite_jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','processing','sent','skipped','failed')),
  reason_code text,
  error_code text,
  attempt_count integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id,participant_id)
);

create index idx_account_invite_job_items_claim
  on public.account_invite_job_items(job_id,status,created_at,id);
create index idx_account_invite_job_items_recent_sent
  on public.account_invite_job_items(participant_id,sent_at desc)
  where status='sent';

alter table public.account_invite_jobs enable row level security;
alter table public.account_invite_job_items enable row level security;

create policy account_invite_jobs_admin_select on public.account_invite_jobs
  for select to authenticated using (
    public.user_can_access_organization(auth.uid(),organization_id)
    and public.current_user_has_permission('participants.edit_basic')
  );
create policy account_invite_job_items_admin_select on public.account_invite_job_items
  for select to authenticated using (
    public.user_can_access_organization(auth.uid(),organization_id)
    and public.current_user_has_permission('participants.edit_basic')
  );

create or replace function public.preview_import_account_invites(p_import_batch_id uuid)
returns table(total_count bigint,eligible_count bigint,already_linked_count bigint,invalid_email_count bigint,recently_invited_count bigint,other_skipped_count bigint)
language sql security definer set search_path=public,pg_temp as $$
  with batch as (
    select ib.* from public.import_batches ib
    where ib.id=p_import_batch_id and ib.status='completed'
      and public.current_user_has_permission('participants.edit_basic')
      and public.user_can_access_organization(auth.uid(),ib.organization_id)
  ), candidates as (
    select distinct ph.participant_id
    from batch b join public.participation_history ph on ph.import_batch_id=b.id and ph.source='import'
    where ph.participant_id is not null
  ), evaluated as (
    select c.participant_id,
      case when recent.participant_id is not null then false else coalesce(e.eligible,false) end eligible,
      case when recent.participant_id is not null then 'recently_invited' else coalesce(e.reason_code,'other') end reason_code
    from candidates c
    cross join lateral public.check_participant_account_invite_eligibility(c.participant_id) e
    left join lateral (
      select i.participant_id from public.account_invite_job_items i
      where i.participant_id=c.participant_id and i.status='sent' and i.sent_at>now()-interval '24 hours'
      limit 1
    ) recent on true
  )
  select count(*),count(*) filter(where eligible),count(*) filter(where reason_code='already_linked'),
    count(*) filter(where reason_code in ('missing_email','invalid_email')),
    count(*) filter(where reason_code='recently_invited'),
    count(*) filter(where not eligible and reason_code not in ('already_linked','missing_email','invalid_email','recently_invited'))
  from evaluated
$$;

create or replace function public.start_import_account_invite_job(p_import_batch_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_batch public.import_batches%rowtype; v_job uuid;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  select * into v_batch from public.import_batches where id=p_import_batch_id and status='completed' for update;
  if not found or not public.user_can_access_organization(v_actor,v_batch.organization_id) then raise exception 'Importacao invalida ou sem acesso.'; end if;
  select id into v_job from public.account_invite_jobs where import_batch_id=v_batch.id and status in ('pending','processing') limit 1;
  if v_job is not null then return v_job; end if;
  begin
    insert into public.account_invite_jobs(organization_id,import_batch_id,created_by)
    values(v_batch.organization_id,v_batch.id,v_actor) returning id into v_job;
  exception when unique_violation then
    select id into v_job from public.account_invite_jobs where import_batch_id=v_batch.id and status in ('pending','processing') limit 1;
    return v_job;
  end;
  insert into public.account_invite_job_items(job_id,organization_id,participant_id,status,reason_code,finished_at)
  select v_job,v_batch.organization_id,c.participant_id,
    case when recent.participant_id is not null or not coalesce(e.eligible,false) then 'skipped' else 'pending' end,
    case when recent.participant_id is not null then 'recently_invited' else coalesce(e.reason_code,'other') end,
    case when recent.participant_id is not null or not coalesce(e.eligible,false) then now() end
  from (select distinct ph.participant_id from public.participation_history ph where ph.import_batch_id=v_batch.id and ph.source='import' and ph.participant_id is not null) c
  cross join lateral public.check_participant_account_invite_eligibility(c.participant_id) e
  left join lateral (select i.participant_id from public.account_invite_job_items i where i.participant_id=c.participant_id and i.status='sent' and i.sent_at>now()-interval '24 hours' limit 1) recent on true;
  update public.account_invite_jobs j set
    total_count=s.total,eligible_count=s.eligible,processed_count=s.skipped,skipped_count=s.skipped,
    status=case when s.eligible=0 then 'completed' else 'pending' end,
    finished_at=case when s.eligible=0 then now() end,updated_at=now()
  from (select count(*)::int total,count(*) filter(where status='pending')::int eligible,count(*) filter(where status='skipped')::int skipped from public.account_invite_job_items where job_id=v_job) s
  where j.id=v_job;
  return v_job;
end $$;

create or replace function public.claim_account_invite_job_items(p_job_id uuid,p_limit integer default 25)
returns table(item_id uuid,participant_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  if not exists(select 1 from public.account_invite_jobs j where j.id=p_job_id and public.user_can_access_organization(auth.uid(),j.organization_id)) then raise exception 'Job invalido ou sem acesso.'; end if;
  update public.account_invite_job_items i set status='pending',claimed_at=null,updated_at=now()
    where i.job_id=p_job_id and i.status='processing' and i.claimed_at<now()-interval '10 minutes';
  update public.account_invite_jobs set status='processing',started_at=coalesce(started_at,now()),updated_at=now() where id=p_job_id and status='pending';
  return query with picked as (
    select i.id from public.account_invite_job_items i where i.job_id=p_job_id and i.status='pending'
    order by i.created_at,i.id for update skip locked limit least(greatest(coalesce(p_limit,25),1),25)
  ), claimed as (
    update public.account_invite_job_items i set status='processing',attempt_count=attempt_count+1,claimed_at=now(),updated_at=now()
    from picked where i.id=picked.id returning i.id,i.participant_id
  ) select id,participant_id from claimed;
end $$;

create or replace function public.finish_account_invite_job_item(p_item_id uuid,p_status text,p_reason_code text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job uuid;
begin
  if auth.uid() is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  if p_status not in ('sent','skipped','failed') then raise exception 'Status invalido.'; end if;
  update public.account_invite_job_items i set status=p_status,reason_code=case when p_status='failed' then reason_code else p_reason_code end,
    error_code=case when p_status='failed' then coalesce(nullif(p_reason_code,''),'provider_error') else null end,
    sent_at=case when p_status='sent' then now() else sent_at end,finished_at=now(),updated_at=now()
  from public.account_invite_jobs j where i.id=p_item_id and i.job_id=j.id
    and public.user_can_access_organization(auth.uid(),j.organization_id) returning i.job_id into v_job;
  if v_job is null then raise exception 'Item invalido ou sem acesso.'; end if;
  update public.account_invite_jobs j set processed_count=s.processed,sent_count=s.sent,skipped_count=s.skipped,failed_count=s.failed,
    status=case when s.opened=0 then case when s.failed>0 then 'completed_with_failures' else 'completed' end else 'processing' end,
    finished_at=case when s.opened=0 then now() else null end,updated_at=now()
  from (select count(*) filter(where status in ('sent','skipped','failed'))::int processed,count(*) filter(where status='sent')::int sent,
    count(*) filter(where status='skipped')::int skipped,count(*) filter(where status='failed')::int failed,
    count(*) filter(where status in ('pending','processing'))::int opened from public.account_invite_job_items where job_id=v_job) s where j.id=v_job;
end $$;

create or replace function public.check_account_invite_job_item_turn(p_item_id uuid)
returns table(allowed boolean,reason_code text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_item public.account_invite_job_items%rowtype;
begin
  select i.* into v_item from public.account_invite_job_items i join public.account_invite_jobs j on j.id=i.job_id
  where i.id=p_item_id and i.status='processing'
    and public.user_can_access_organization(auth.uid(),j.organization_id);
  if not found or auth.uid() is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Item invalido ou sem acesso.'; end if;
  if exists(select 1 from public.account_invite_job_items other where other.participant_id=v_item.participant_id
      and other.id<>v_item.id and other.status='sent' and other.sent_at>now()-interval '24 hours') then
    return query select false,'recently_invited'::text; return;
  end if;
  -- Entre jobs concorrentes de importacoes diferentes, vence sempre o item
  -- processing mais antigo (id desempata). O resultado independe de timing.
  if exists(select 1 from public.account_invite_job_items other where other.participant_id=v_item.participant_id
      and other.id<>v_item.id and other.status='processing'
      and (other.created_at,other.id)<(v_item.created_at,v_item.id)) then
    return query select false,'concurrent_invite'::text; return;
  end if;
  return query select true,null::text;
end $$;

create or replace function public.retry_failed_account_invite_job(p_job_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  if not exists(select 1 from public.account_invite_jobs j where j.id=p_job_id and public.user_can_access_organization(auth.uid(),j.organization_id)) then raise exception 'Job invalido ou sem acesso.'; end if;
  update public.account_invite_job_items set status='pending',error_code=null,reason_code=null,finished_at=null,claimed_at=null,updated_at=now() where job_id=p_job_id and status='failed';
  get diagnostics v_count=row_count;
  update public.account_invite_jobs set status=case when v_count>0 then 'processing' else status end,finished_at=case when v_count>0 then null else finished_at end,updated_at=now() where id=p_job_id;
  return v_count;
end $$;

revoke all on table public.account_invite_jobs,public.account_invite_job_items from public,anon,authenticated;
grant select on table public.account_invite_jobs,public.account_invite_job_items to authenticated;
grant all on table public.account_invite_jobs,public.account_invite_job_items to service_role;
revoke all on function public.preview_import_account_invites(uuid),public.start_import_account_invite_job(uuid),public.claim_account_invite_job_items(uuid,integer),public.finish_account_invite_job_item(uuid,text,text),public.check_account_invite_job_item_turn(uuid),public.retry_failed_account_invite_job(uuid) from public,anon;
grant execute on function public.preview_import_account_invites(uuid),public.start_import_account_invite_job(uuid),public.claim_account_invite_job_items(uuid,integer),public.finish_account_invite_job_item(uuid,text,text),public.check_account_invite_job_item_turn(uuid),public.retry_failed_account_invite_job(uuid) to authenticated;
