begin;

alter table public.import_batch_rows
  add column if not exists identity_match_details jsonb not null default '{}'::jsonb,
  add column if not exists review_decision text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

alter table public.import_batch_rows drop constraint if exists import_batch_rows_review_decision_check;
alter table public.import_batch_rows add constraint import_batch_rows_review_decision_check
  check(review_decision is null or review_decision in('link_existing','create_new','ignore'));

-- Torna revisões antigas operáveis sem decidir por elas: apenas materializa
-- o candidato que já estava gravado em matched_participant_id. Status e
-- resolution permanecem intocados até a decisão humana.
update public.import_batch_rows r set
  registration_contact_id=coalesce(r.registration_contact_id,p.registration_contact_id),
  identity_match_details=jsonb_build_object('reason','legacy_name_only_suggestion','candidates',jsonb_build_array(jsonb_build_object(
    'registration_contact_id',p.registration_contact_id,'participant_id',p.id,'user_id',p.user_id,
    'full_name',p.full_name,'cpf',p.cpf,'email',p.email,'reason','name_exact_suggestion')))
from public.participants p
where r.status='review_required' and r.resolution='pending' and r.matched_participant_id=p.id
  and r.identity_match_details='{}'::jsonb and p.registration_contact_id is not null;

create index if not exists import_batch_rows_pending_review_idx
  on public.import_batch_rows(import_batch_id,created_at)
  where status='review_required' and resolution='pending';

create or replace function public.resolve_import_batch_row_review(
  p_row_id uuid,p_decision text,p_registration_contact_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_row public.import_batch_rows%rowtype; v_batch public.import_batches%rowtype;
  v_contact public.registration_contacts%rowtype; v_candidate_allowed boolean:=false;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_decision not in('link_existing','create_new','ignore') then raise exception 'Decisao de revisao invalida.'; end if;
  select * into v_row from public.import_batch_rows where id=p_row_id for update;
  if not found then raise exception 'Linha de importacao nao encontrada.'; end if;
  select * into v_batch from public.import_batches where id=v_row.import_batch_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_batch.organization_id)
    or not public.resolve_user_permission(v_actor,'imports.view') then raise exception 'Sem permissao para revisar esta importacao.'; end if;
  if v_row.status<>'review_required' or v_row.resolution<>'pending' then
    return jsonb_build_object('success',true,'changed',false,'status',v_row.status,'resolution',v_row.resolution);
  end if;

  if p_decision='link_existing' then
    if p_registration_contact_id is null then raise exception 'Selecione o cadastro candidato.'; end if;
    select * into v_contact from public.registration_contacts where id=p_registration_contact_id and organization_id=v_batch.organization_id;
    if not found then raise exception 'Cadastro candidato invalido para esta organizacao.'; end if;
    select exists(
      select 1 from jsonb_array_elements(coalesce(v_row.identity_match_details->'candidates','[]'::jsonb)) c
      where c->>'registration_contact_id'=p_registration_contact_id::text
    ) or v_row.registration_contact_id=p_registration_contact_id into v_candidate_allowed;
    if not v_candidate_allowed then raise exception 'Cadastro nao consta entre os candidatos auditados desta linha.'; end if;
    update public.import_batch_rows set resolution='link_existing',registration_contact_id=v_contact.id,
      matched_user_id=v_contact.user_id,review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
    where id=v_row.id;
  elsif p_decision='create_new' then
    update public.import_batch_rows set resolution='create_new',registration_contact_id=null,matched_participant_id=null,
      matched_user_id=null,review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
    where id=v_row.id;
  else
    update public.import_batch_rows set status='skipped',resolution='ignore',review_decision=p_decision,
      reviewed_by=v_actor,reviewed_at=now(),updated_at=now() where id=v_row.id;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('import_row_review_resolved','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
    'actor_user_id',v_actor,'import_batch_id',v_batch.id,'decision',p_decision,
    'registration_contact_id',case when p_decision='link_existing' then p_registration_contact_id end,
    'identity_match_details',v_row.identity_match_details));
  return jsonb_build_object('success',true,'changed',true,'status',case when p_decision='ignore' then 'skipped' else 'review_required' end,'resolution',p_decision);
end; $$;

revoke all on function public.resolve_import_batch_row_review(uuid,text,uuid) from public,anon;
grant execute on function public.resolve_import_batch_row_review(uuid,text,uuid) to authenticated,service_role;

commit;
