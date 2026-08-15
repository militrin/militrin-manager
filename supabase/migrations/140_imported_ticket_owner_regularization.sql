-- 140_imported_ticket_owner_regularization.sql
-- Regulariza somente a propriedade atual de tickets com proveniencia importada comprovada.
-- Nao altera comprador historico, titular, pedido, pagamento, QR, kit ou operacoes fisicas.

begin;

create temporary table imported_ticket_owner_resolution on commit drop as
with ticket_context as (
  select
    t.id as ticket_id,
    t.order_id,
    t.order_item_id,
    t.event_id,
    t.organization_id,
    t.owner_user_id as previous_owner_user_id,
    o.user_id as order_user_id,
    o.buyer_type,
    o.import_batch_id as order_import_batch_id,
    o.participant_id as order_participant_id,
    coalesce(oi.participant_id,t.participant_id) as holder_participant_id,
    coalesce(oi.registration_contact_id,hp.registration_contact_id) as registration_contact_id
  from public.tickets t
  join public.orders o on o.id=t.order_id
  left join public.order_items oi on oi.id=t.order_item_id
  left join public.participants hp on hp.id=coalesce(oi.participant_id,t.participant_id)
  where t.organization_id=o.organization_id
), import_evidence as (
  select c.*,
    coalesce(e.import_batch_ids,array[]::uuid[]) as import_batch_ids,
    coalesce(e.imported_by_user_ids,array[]::uuid[]) as imported_by_user_ids,
    (c.buyer_type='imported_holder' or cardinality(coalesce(e.import_batch_ids,array[]::uuid[]))>0) as is_imported
  from ticket_context c
  left join lateral (
    select
      array_agg(distinct ib.id order by ib.id) as import_batch_ids,
      array_agg(distinct ib.imported_by order by ib.imported_by)
        filter(where ib.imported_by is not null) as imported_by_user_ids
    from public.import_batches ib
    where ib.id=c.order_import_batch_id
       or exists(
         select 1 from public.participation_history ph
         where ph.import_batch_id=ib.id
           and ph.source='import'
           and ph.participant_id in(c.order_participant_id,c.holder_participant_id)
       )
  ) e on true
), resolved as (
  select e.*,
    coalesce(a.account_count,0)::integer as holder_account_count,
    case when coalesce(a.account_count,0)=1 then a.owner_user_id end as expected_owner_user_id
  from import_evidence e
  left join lateral (
    select count(distinct p.user_id) as account_count,
      (array_agg(distinct p.user_id order by p.user_id))[1] as owner_user_id
    from public.participants p
    join auth.users au on au.id=p.user_id
    where e.registration_contact_id is not null
      and p.organization_id=e.organization_id
      and p.registration_contact_id=e.registration_contact_id
      and not(p.user_id=any(e.imported_by_user_ids))
  ) a on true
  where e.is_imported
)
select *,
  case
    when holder_account_count>1 then 'AMBIGUOUS'
    when previous_owner_user_id is not distinct from expected_owner_user_id then 'OWNER_CORRETO'
    when expected_owner_user_id is null then 'OWNER_DEVE_FICAR_NULL'
    else 'OWNER_DEVE_SER_TITULAR_COM_CONTA'
  end as classification
from resolved;

do $$
declare v_ambiguous integer;
begin
  select count(*) into v_ambiguous
  from imported_ticket_owner_resolution where holder_account_count>1;
  if v_ambiguous>0 then
    raise exception 'IMPORTED_TICKET_OWNER_AMBIGUOUS: % ticket(s) possuem mais de uma conta valida para o contato do titular.',v_ambiguous;
  end if;
end; $$;

-- Auditoria dedicada: regularizacao de legado nao e transferencia comum de propriedade.
insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
select 'imported_ticket_owner_regularized','tickets',r.ticket_id,r.event_id,
  jsonb_build_object(
    'ticket_id',r.ticket_id,
    'previous_owner_user_id',r.previous_owner_user_id,
    'new_owner_user_id',r.expected_owner_user_id,
    'reason','regularization_import_operator_as_owner',
    'reason_code','data_regularization',
    'import_batch_id',case when cardinality(r.import_batch_ids)=1 then r.import_batch_ids[1] end,
    'import_batch_ids',to_jsonb(r.import_batch_ids),
    'registration_contact_id',r.registration_contact_id,
    'holder_account_user_id',r.expected_owner_user_id,
    'imported_by_user_ids',to_jsonb(r.imported_by_user_ids),
    'order_user_id',r.order_user_id,
    'actor_user_id',auth.uid(),
    'actor_origin','migration',
    'technical_actor','migration:140_imported_ticket_owner_regularization',
    'database_role',current_user,
    'classification_before_regularization',r.classification,
    'regularized_at',now()
  )
from imported_ticket_owner_resolution r
where r.previous_owner_user_id is distinct from r.expected_owner_user_id;

update public.tickets t
set owner_user_id=r.expected_owner_user_id
from imported_ticket_owner_resolution r
where t.id=r.ticket_id
  and r.holder_account_count<=1
  and t.owner_user_id is distinct from r.expected_owner_user_id;

-- Substitui somente o trigger da 139. Proveniencia importada tem precedencia
-- sobre buyer_type e nunca usa orders.user_id/import_batches.imported_by como owner.
create or replace function public.trg_initialize_ticket_owner()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_holder public.participants%rowtype;
  v_registration_contact_id uuid;
  v_import_batch_ids uuid[]:=array[]::uuid[];
  v_imported_by_user_ids uuid[]:=array[]::uuid[];
  v_holder_account_count integer:=0;
  v_expected_owner_user_id uuid;
  v_is_imported boolean:=false;
begin
  select * into v_order from public.orders where id=new.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  if new.organization_id is distinct from v_order.organization_id then
    raise exception 'Organizacao do ingresso diverge do pedido.';
  end if;

  if new.order_item_id is not null then
    select * into v_item from public.order_items where id=new.order_item_id;
  end if;
  if coalesce(v_item.participant_id,new.participant_id) is not null then
    select * into v_holder from public.participants where id=coalesce(v_item.participant_id,new.participant_id);
  end if;
  v_registration_contact_id:=coalesce(v_item.registration_contact_id,v_holder.registration_contact_id);

  select
    coalesce(array_agg(distinct ib.id order by ib.id),array[]::uuid[]),
    coalesce(array_agg(distinct ib.imported_by order by ib.imported_by)
      filter(where ib.imported_by is not null),array[]::uuid[])
  into v_import_batch_ids,v_imported_by_user_ids
  from public.import_batches ib
  where ib.id=v_order.import_batch_id
     or exists(
       select 1 from public.participation_history ph
       where ph.import_batch_id=ib.id
         and ph.source='import'
         and ph.participant_id in(v_order.participant_id,coalesce(v_item.participant_id,new.participant_id))
     );
  v_is_imported:=v_order.buyer_type='imported_holder' or cardinality(v_import_batch_ids)>0;

  if v_is_imported then
    select count(distinct p.user_id),(array_agg(distinct p.user_id order by p.user_id))[1]
    into v_holder_account_count,v_expected_owner_user_id
    from public.participants p
    join auth.users au on au.id=p.user_id
    where v_registration_contact_id is not null
      and p.organization_id=new.organization_id
      and p.registration_contact_id=v_registration_contact_id
      and not(p.user_id=any(v_imported_by_user_ids));
    if v_holder_account_count>1 then
      raise exception 'IMPORTED_TICKET_OWNER_AMBIGUOUS: contato do titular possui mais de uma conta valida.';
    end if;
    new.owner_user_id:=case when v_holder_account_count=1 then v_expected_owner_user_id else null end;
    return new;
  end if;

  if new.owner_user_id is not null then return new; end if;
  if v_order.buyer_type='account' then
    if v_order.user_id is null or not exists(select 1 from auth.users where id=v_order.user_id) then
      raise exception 'Pedido de conta sem comprador autenticado valido.';
    end if;
    new.owner_user_id:=v_order.user_id;
  else
    raise exception 'Origem do pedido nao permite inicializar proprietario.';
  end if;
  return new;
end; $$;

drop trigger if exists initialize_ticket_owner on public.tickets;
create trigger initialize_ticket_owner
before insert on public.tickets
for each row execute function public.trg_initialize_ticket_owner();

revoke all on function public.trg_initialize_ticket_owner() from public,anon,authenticated;

commit;
