-- 087_ticket_kit_items_operational_ownership.sql
-- Torna o ingresso a unidade operacional dos itens, preservando os vinculos legados.

begin;

alter table public.participant_kit_items
  add column if not exists ticket_id uuid references public.tickets(id) on delete cascade,
  add column if not exists order_item_id uuid references public.order_items(id) on delete set null,
  add column if not exists legacy_unresolved boolean not null default false;

alter table public.participant_kit_items
  alter column participant_id drop not null;

-- Estabiliza as fontes usadas pelo backfill; nenhuma emissao/atribuicao pode correr
-- em paralelo e produzir uma associacao diferente durante a classificacao.
lock table public.tickets in share mode;
lock table public.order_items in share mode;
lock table public.orders in share mode;
lock table public.payments in share mode;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.participant_kit_items'::regclass
      and conname = 'participant_kit_items_participant_id_fkey'
  ) then
    alter table public.participant_kit_items
      drop constraint participant_kit_items_participant_id_fkey;
  end if;
  alter table public.participant_kit_items
    add constraint participant_kit_items_participant_id_fkey
    foreign key (participant_id) references public.participants(id) on delete set null;
end;
$$;

-- Regulariza somente participantes cuja importacao e comprovada por lote valido.
-- Nenhum valor financeiro, categoria, lote ou camiseta e inferido.
create temporary table imported_ticket_chain_repair on commit drop as
with current_candidates as (
  select distinct pki.id participant_kit_item_id, t.id ticket_id
  from public.participant_kit_items pki
  join public.tickets t on t.event_id=pki.event_id and t.status<>'cancelled'
  left join public.order_items oi on oi.id=t.order_item_id
  where pki.ticket_id is null
    and (oi.participant_id=pki.participant_id or t.participant_id=pki.participant_id)
), zero_participants as (
  select pki.participant_id,pki.event_id,array_agg(pki.id order by pki.id) participant_kit_item_ids
  from public.participant_kit_items pki
  where pki.ticket_id is null
    and pki.participant_id is not null
    and not exists(select 1 from current_candidates c where c.participant_kit_item_id=pki.id)
  group by pki.participant_id,pki.event_id
), import_evidence as (
  select z.participant_id,z.event_id,z.participant_kit_item_ids,
    array_agg(distinct ph.import_batch_id order by ph.import_batch_id)
      filter(where ph.import_batch_id is not null) import_batch_ids,
    count(distinct ph.import_batch_id) filter(where ph.import_batch_id is not null) import_batch_count
  from zero_participants z
  join public.participation_history ph
    on ph.participant_id=z.participant_id and ph.event_id=z.event_id
   and ph.source='import' and ph.import_batch_id is not null
  join public.import_batches ib
    on ib.id=ph.import_batch_id and ib.event_id=z.event_id
   and ib.import_type='current_event_registrations'
  group by z.participant_id,z.event_id,z.participant_kit_item_ids
), base as (
  select ie.*,
    case when ie.import_batch_count=1 then ie.import_batch_ids[1] end import_batch_id,
    p.full_name,p.ticket_category_id,p.batch_id,p.shirt_type,p.shirt_size,p.reservation_expires_at,
    e.organization_id,
    all_orders.order_count any_order_count,
    existing_order.order_count,existing_order.order_id,existing_order.payment_id order_payment_id,
    existing_items.order_item_count,existing_items.ticket_count,
    payment_candidate.payment_count,payment_candidate.payment_id candidate_payment_id
  from import_evidence ie
  join public.participants p on p.id=ie.participant_id and p.event_id=ie.event_id
  join public.events e on e.id=ie.event_id
  left join lateral (
    select count(*)::integer order_count from public.orders o
    where o.participant_id=ie.participant_id and o.event_id=ie.event_id
  ) all_orders on true
  left join lateral (
    select count(*)::integer order_count,
      (array_agg(o.id order by o.id))[1] order_id,
      (array_agg(o.payment_id order by o.id))[1] payment_id
    from public.orders o
    where o.participant_id=ie.participant_id and o.event_id=ie.event_id
      and o.buyer_type='imported_holder' and o.user_id is null
      and o.import_batch_id=case when ie.import_batch_count=1 then ie.import_batch_ids[1] end
  ) existing_order on true
  left join lateral (
    select count(*)::integer order_item_count,
      count(*) filter(where exists(
        select 1 from public.tickets t where t.order_item_id=oi.id
      ))::integer ticket_count
    from public.order_items oi
    where oi.order_id=existing_order.order_id and oi.participant_id=ie.participant_id
  ) existing_items on true
  left join lateral (
    select count(*)::integer payment_count,
      (array_agg(pay.id order by pay.id))[1] payment_id
    from public.payments pay
    where pay.participant_id=ie.participant_id and pay.event_id=ie.event_id
  ) payment_candidate on true
), classified as (
  select base.*,
    coalesce(base.order_payment_id,
      case when base.payment_count=1 then base.candidate_payment_id end) resolved_payment_id,
    case
      when base.import_batch_count<>1 then 'mais de um import_batch_id comprovado'
      when base.organization_id is null then 'evento sem organization_id'
      when base.ticket_category_id is null then 'participante sem ticket_category_id comprovado'
      when base.batch_id is null then 'participante sem batch_id comprovado'
      when base.order_count=0 and base.any_order_count>0 then 'existe pedido nao importado para o participante; criacao bloquearia unicidade'
      when base.order_count>1 then 'mais de um pedido importado correspondente'
      when base.order_item_count>1 then 'mais de um order_item correspondente no pedido importado'
      when base.ticket_count>1 then 'mais de um ticket correspondente no pedido importado'
      when base.order_payment_id is null and base.payment_count<>1 then 'pagamento nao e unico nem esta vinculado ao pedido'
      else null
    end structural_skip_reason
  from base
)
select classified.*,
  case
    when classified.structural_skip_reason is not null then classified.structural_skip_reason
    when pay.id is null then 'pagamento comprovado nao encontrado'
    when pay.event_id is distinct from classified.event_id then 'pagamento pertence a outro evento'
    when pay.amount is null or pay.final_amount is null then 'pagamento sem valores financeiros reais'
    else null
  end skip_reason,
  (classified.structural_skip_reason is null and pay.id is not null
    and pay.event_id=classified.event_id and pay.amount is not null and pay.final_amount is not null) eligible
from classified
left join public.payments pay on pay.id=classified.resolved_payment_id;

-- Diagnostico obrigatorio antes de qualquer criacao.
select participant_id,event_id,import_batch_id,participant_kit_item_ids,
  order_count,order_id,payment_count,resolved_payment_id,eligible,skip_reason
from imported_ticket_chain_repair
order by event_id,participant_id;

-- Pedido importado: criado apenas quando nao existe o pedido exato do lote.
insert into public.orders(
  user_id,participant_id,event_id,payment_id,order_number,status,
  base_amount,discount_amount,final_amount,buyer_type,import_batch_id,confirmed_at
)
select null,r.participant_id,r.event_id,r.resolved_payment_id,public.generate_order_number(),
  case when pay.payment_status='paid' then 'confirmed' else 'pending' end,
  pay.amount,coalesce(pay.discount_amount,0),pay.final_amount,
  'imported_holder',r.import_batch_id,
  case when pay.payment_status='paid' then now() end
from imported_ticket_chain_repair r
join public.payments pay on pay.id=r.resolved_payment_id
where r.eligible and r.order_count=0
  and pay.amount is not null and pay.final_amount is not null
  and not exists(
    select 1 from public.orders o
    where o.participant_id=r.participant_id and o.event_id=r.event_id
      and o.buyer_type='imported_holder' and o.user_id is null
      and o.import_batch_id=r.import_batch_id
  );

-- Resolve o pedido depois da criacao sem escolher por data ou posicao.
update imported_ticket_chain_repair r
set order_id=resolved.id,order_count=resolved.order_count
from (
  select o.participant_id,o.event_id,o.import_batch_id,
    count(*)::integer order_count,(array_agg(o.id order by o.id))[1] id
  from public.orders o
  where o.buyer_type='imported_holder' and o.user_id is null and o.import_batch_id is not null
  group by o.participant_id,o.event_id,o.import_batch_id
) resolved
where r.eligible and resolved.participant_id=r.participant_id
  and resolved.event_id=r.event_id and resolved.import_batch_id=r.import_batch_id
  and resolved.order_count=1;

-- Order item usa exclusivamente os dados reais do participante e do pagamento.
insert into public.order_items(
  order_id,event_id,participant_id,ownership_status,holder_full_name,
  ticket_category_id,batch_id,shirt_type,shirt_size,quantity,
  unit_price,discount_amount,final_amount,status,reservation_expires_at
)
select r.order_id,r.event_id,r.participant_id,'assigned',r.full_name,
  r.ticket_category_id,r.batch_id,r.shirt_type,r.shirt_size,1,
  pay.amount,coalesce(pay.discount_amount,0),pay.final_amount,
  case when pay.payment_status='paid' then 'confirmed' else 'reserved' end,
  case when pay.payment_status='paid' then null else r.reservation_expires_at end
from imported_ticket_chain_repair r
join public.payments pay on pay.id=r.resolved_payment_id
where r.eligible and r.order_count=1 and r.order_id is not null
  and pay.amount is not null and pay.final_amount is not null
  and not exists(
    select 1 from public.order_items oi
    where oi.order_id=r.order_id and oi.participant_id=r.participant_id
  );

-- Ticket e emitido para o order_item exato; pagamento nao e alterado.
-- Nao usa confirm_order_item_and_issue_ticket: o reparo tambem preserva pedidos
-- pendentes e a funcao canonica exige pagamento pago. Os campos abaixo sao
-- exclusivamente os existentes no schema operacional de tickets.
insert into public.tickets(
  order_id,order_item_id,participant_id,event_id,organization_id,token,status,issued_at
)
select r.order_id,oi.id,r.participant_id,r.event_id,r.organization_id,
  gen_random_uuid(),'active',now()
from imported_ticket_chain_repair r
join public.order_items oi on oi.order_id=r.order_id and oi.participant_id=r.participant_id
where r.eligible and r.order_count=1
  and (select count(*) from public.order_items x
       where x.order_id=r.order_id and x.participant_id=r.participant_id)=1
  and not exists(select 1 from public.tickets t where t.order_item_id=oi.id);

-- Auditoria do reparo completo ou da regularizacao ignorada por falta estrutural.
insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
select 'imported_ticket_chain_repaired','participants',r.participant_id,r.event_id,
  jsonb_build_object(
    'participant_id',r.participant_id,'import_batch_id',r.import_batch_id,
    'order_id',o.id,'order_item_id',oi.id,'ticket_id',t.id,
    'participant_kit_item_ids',r.participant_kit_item_ids,
    'operation','imported_ticket_chain_repaired','source','migration_087'
  )
from imported_ticket_chain_repair r
join public.orders o on o.participant_id=r.participant_id and o.event_id=r.event_id
  and o.buyer_type='imported_holder' and o.user_id is null and o.import_batch_id=r.import_batch_id
join public.order_items oi on oi.order_id=o.id and oi.participant_id=r.participant_id
join public.tickets t on t.order_item_id=oi.id
where r.eligible
  and not exists(
    select 1 from public.audit_logs al
    where al.action='imported_ticket_chain_repaired'
      and al.entity_id=r.participant_id
      and al.details->>'source'='migration_087'
      and al.details->>'import_batch_id'=r.import_batch_id::text
  );

insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
select 'imported_ticket_chain_repair_skipped','participants',r.participant_id,r.event_id,
  jsonb_build_object(
    'participant_id',r.participant_id,'import_batch_id',r.import_batch_id,
    'participant_kit_item_ids',r.participant_kit_item_ids,
    'reason',r.skip_reason,'operation','imported_ticket_chain_repair_skipped',
    'source','migration_087'
  )
from imported_ticket_chain_repair r
where not r.eligible
  and not exists(
    select 1 from public.audit_logs al
    where al.action='imported_ticket_chain_repair_skipped'
      and al.entity_id=r.participant_id
      and al.details->>'source'='migration_087'
      and al.details->>'import_batch_id' is not distinct from r.import_batch_id::text
  );

create temporary table ticket_kit_backfill_diagnostic on commit drop as
with candidates as (
  select pki.id participant_kit_item_id, t.id ticket_id,
    case
      when t.order_item_id is not null and oi.participant_id = pki.participant_id then 1
      when t.participant_id = pki.participant_id then 2
      else 3
    end evidence_rank
  from public.participant_kit_items pki
  join public.tickets t on t.event_id = pki.event_id and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where pki.ticket_id is null
    and pki.participant_id is not null
    and (oi.participant_id = pki.participant_id or t.participant_id = pki.participant_id)
), best_rank as (
  select participant_kit_item_id, min(evidence_rank) evidence_rank
  from candidates group by participant_kit_item_id
), ranked as (
  select c.participant_kit_item_id,
    array_agg(c.ticket_id order by c.ticket_id) candidate_ticket_ids,
    count(*) candidate_count,
    (array_agg(c.ticket_id order by c.ticket_id))[1] resolved_ticket_id,
    b.evidence_rank
  from candidates c join best_rank b using (participant_kit_item_id)
  where c.evidence_rank = b.evidence_rank
  group by c.participant_kit_item_id, b.evidence_rank
)
select pki.id participant_kit_item_id, pki.participant_id, pki.event_id,
  pki.kit_item_id, pki.status, pki.delivered_at,
  coalesce(r.candidate_ticket_ids, array[]::uuid[]) candidate_ticket_ids,
  coalesce(r.candidate_count, 0) candidate_count,
  case when r.candidate_count = 1 then r.resolved_ticket_id end resolved_ticket_id,
  case
    when r.candidate_count = 1 and r.evidence_rank = 1 then 'order_item.participant_id; candidato unico'
    when r.candidate_count = 1 then 'tickets.participant_id; candidato unico no evento'
    when coalesce(r.candidate_count, 0) = 0 then 'sem ticket candidato comprovavel'
    else 'mais de um ticket candidato; resolucao manual obrigatoria'
  end resolution_reason
from public.participant_kit_items pki
left join ranked r on r.participant_kit_item_id = pki.id
where pki.ticket_id is null;

select * from ticket_kit_backfill_diagnostic order by event_id, participant_id, participant_kit_item_id;

update public.participant_kit_items pki
set ticket_id = d.resolved_ticket_id,
    order_item_id = t.order_item_id
from ticket_kit_backfill_diagnostic d
join public.tickets t on t.id = d.resolved_ticket_id
where pki.id = d.participant_kit_item_id
  and d.candidate_count = 1
  and not exists (
    select 1 from public.participant_kit_items other
    where other.id <> pki.id
      and other.ticket_id = d.resolved_ticket_id
      and other.kit_item_id = pki.kit_item_id
  );

-- Excecao permanente e explicita somente para o legado sem pedido nem origem de importacao.
update public.participant_kit_items pki
set legacy_unresolved=true
from ticket_kit_backfill_diagnostic d
where pki.id=d.participant_kit_item_id
  and pki.ticket_id is null and d.candidate_count=0
  and not exists(select 1 from public.orders o where o.participant_id=d.participant_id and o.event_id=d.event_id)
  and not exists(
    select 1 from public.participation_history ph
    join public.import_batches ib on ib.id=ph.import_batch_id
    where ph.participant_id=d.participant_id and ph.event_id=d.event_id
      and ph.source='import' and ib.event_id=d.event_id
      and ib.import_type='current_event_registrations'
  );

alter table public.participant_kit_items
  drop constraint if exists participant_kit_items_operational_owner_check;
alter table public.participant_kit_items
  add constraint participant_kit_items_operational_owner_check check (
    ticket_id is not null or order_item_id is not null or legacy_unresolved
  );

create temporary table ticket_kit_uniqueness_conflicts on commit drop as
select ticket_id, kit_item_id, array_agg(id order by id) link_ids, count(*) conflict_count
from public.participant_kit_items
where ticket_id is not null
group by ticket_id, kit_item_id
having count(*) > 1;

select * from ticket_kit_uniqueness_conflicts order by ticket_id, kit_item_id;

do $$
declare v_conflicts integer;
begin
  select count(*) into v_conflicts from ticket_kit_uniqueness_conflicts;
  if v_conflicts > 0 then
    raise exception 'Backfill interrompido: % conflitos de unicidade ticket/item exigem revisao.', v_conflicts;
  end if;
end;
$$;

create unique index if not exists ux_participant_kit_items_ticket_item
  on public.participant_kit_items(ticket_id, kit_item_id)
  where ticket_id is not null;
create index if not exists idx_participant_kit_items_ticket_status
  on public.participant_kit_items(ticket_id, status)
  where ticket_id is not null;

create unique index if not exists ux_participant_kit_items_order_item_item
  on public.participant_kit_items(order_item_id, kit_item_id)
  where order_item_id is not null;

alter table public.participant_kit_items
  drop constraint if exists participant_kit_items_participant_kit_unique;
drop index if exists public.ux_participant_kit_items_participant_item;
alter table public.participant_kit_items
  add constraint participant_kit_items_participant_kit_unique
  unique (order_item_id, kit_item_id);

create or replace function public.trg_ticket_kit_item_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.tickets%rowtype;
  v_order_item public.order_items%rowtype;
  v_item public.event_kit_items%rowtype;
  v_event_org uuid;
begin
  if new.ticket_id is null and new.order_item_id is null then
    if tg_op = 'INSERT' then
      -- Funcoes historicas ainda tentam inserir por participante antes de criar o
      -- order_item. A reserva de estoque feita por elas e preservada, mas o
      -- vinculo sem chave operacional nao e materializado. O trigger de
      -- order_items abaixo cria o mesmo item com chave deterministica.
      return null;
    end if;
    if coalesce(old.legacy_unresolved,false) and new.legacy_unresolved then return new; end if;
    raise exception 'Item de kit sem ticket_id/order_item_id nao e um legado autorizado.';
  end if;

  if new.ticket_id is not null then
    select * into v_ticket from public.tickets where id = new.ticket_id;
    if not found then raise exception 'Ingresso do item nao encontrado.'; end if;
    if v_ticket.order_item_id is null then raise exception 'Ingresso sem order_item deterministico.'; end if;
    if new.order_item_id is not null and new.order_item_id is distinct from v_ticket.order_item_id then
      raise exception 'order_item divergente do ingresso.';
    end if;
    new.order_item_id := v_ticket.order_item_id;
  end if;

  select * into v_order_item from public.order_items where id = new.order_item_id;
  if not found then raise exception 'Order item do kit nao encontrado.'; end if;
  if new.ticket_id is null then
    v_ticket.event_id := v_order_item.event_id;
    v_ticket.participant_id := v_order_item.participant_id;
  end if;
  select * into v_item from public.event_kit_items where id = new.kit_item_id;
  if not found or v_item.event_id is distinct from v_ticket.event_id then
    raise exception 'Item de kit nao pertence ao evento do ingresso.';
  end if;
  select organization_id into v_event_org from public.events where id = v_ticket.event_id;
  if v_event_org is null then raise exception 'Evento do ingresso nao encontrado.'; end if;
  if new.event_id is not null and new.event_id is distinct from v_ticket.event_id then
    raise exception 'Evento divergente no item operacional.';
  end if;
  if new.organization_id is not null and new.organization_id is distinct from v_event_org then
    raise exception 'Organizacao divergente no item operacional.';
  end if;

  new.event_id := v_ticket.event_id;
  new.organization_id := v_event_org;
  new.participant_id := coalesce(v_order_item.participant_id, v_ticket.participant_id);
  return new;
end;
$$;

drop trigger if exists trg_ticket_kit_item_consistency on public.participant_kit_items;
create trigger trg_ticket_kit_item_consistency
before insert or update of ticket_id, order_item_id, kit_item_id, event_id, organization_id, participant_id
on public.participant_kit_items
for each row execute function public.trg_ticket_kit_item_consistency();

create or replace function public.materialize_order_item_kit_reservations()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item public.event_kit_items%rowtype; v_org uuid;
begin
  if new.status in ('cancelled','expired','refunded') then return new; end if;
  select organization_id into v_org from public.events where id=new.event_id;
  for v_item in select * from public.event_kit_items where event_id=new.event_id and is_active order by sort_order,created_at loop
    if v_item.item_type='shirt' and (nullif(trim(new.shirt_type),'') is null or nullif(trim(new.shirt_size),'') is null) then continue; end if;
    insert into public.participant_kit_items(order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(new.id,new.participant_id,new.event_id,v_org,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object('shirt_type',new.shirt_type,'shirt_size',new.shirt_size) end,
      v_item.quantity_per_participant,case when new.status='confirmed' then 'confirmed' else 'reserved' end)
    on conflict on constraint participant_kit_items_participant_kit_unique do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_materialize_order_item_kit_reservations on public.order_items;
create trigger trg_materialize_order_item_kit_reservations
after insert on public.order_items for each row execute function public.materialize_order_item_kit_reservations();

create or replace function public.sync_ticket_kit_auxiliary_participant()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.participant_kit_items
  set participant_id = new.participant_id
  where ticket_id = new.id and participant_id is distinct from new.participant_id;
  return new;
end;
$$;

drop trigger if exists trg_ticket_kit_auxiliary_participant on public.tickets;
create trigger trg_ticket_kit_auxiliary_participant
after update of participant_id on public.tickets
for each row execute function public.sync_ticket_kit_auxiliary_participant();

create or replace function public.sync_order_item_participant_to_ticket()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.tickets set participant_id=new.participant_id
  where order_item_id=new.id and participant_id is distinct from new.participant_id;
  update public.participant_kit_items set participant_id=new.participant_id
  where order_item_id=new.id and participant_id is distinct from new.participant_id;
  return new;
end;
$$;

create or replace function public.attach_order_item_kit_items_to_new_ticket()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype; v_org uuid;
begin
  if new.order_item_id is null then return new; end if;
  select * into v_oi from public.order_items where id=new.order_item_id;
  if not found then raise exception 'Order item do ingresso nao encontrado.'; end if;
  select organization_id into v_org from public.events where id=new.event_id;
  for v_item in select * from public.event_kit_items where event_id=new.event_id and is_active order by sort_order,created_at loop
    if v_item.item_type='shirt' and (nullif(trim(v_oi.shirt_type),'') is null or nullif(trim(v_oi.shirt_size),'') is null) then continue; end if;
    insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(new.id,v_oi.id,v_oi.participant_id,new.event_id,v_org,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object('shirt_type',v_oi.shirt_type,'shirt_size',v_oi.shirt_size) end,
      v_item.quantity_per_participant,case when v_oi.status='confirmed' then 'confirmed' else 'reserved' end)
    on conflict on constraint participant_kit_items_participant_kit_unique do update set ticket_id=excluded.ticket_id;
  end loop;
  update public.participant_kit_items pki
  set ticket_id=new.id
  where pki.ticket_id is null and pki.order_item_id=new.order_item_id;
  return new;
end;
$$;

drop trigger if exists trg_attach_unresolved_kit_items_to_ticket on public.tickets;
create trigger trg_attach_unresolved_kit_items_to_ticket
after insert on public.tickets for each row execute function public.attach_order_item_kit_items_to_new_ticket();

-- Completa deterministicamente tickets existentes que nao possuam todos os itens
-- ativos. Linhas legadas ambiguas permanecem intactas e separadas no diagnostico.
insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
select t.id,oi.id,oi.participant_id,t.event_id,e.organization_id,eki.id,
  case when eki.item_type='shirt' then jsonb_build_object('shirt_type',oi.shirt_type,'shirt_size',oi.shirt_size) end,
  eki.quantity_per_participant,case when oi.status='confirmed' then 'confirmed' else 'reserved' end
from public.tickets t
join public.order_items oi on oi.id=t.order_item_id
join public.events e on e.id=t.event_id
join public.event_kit_items eki on eki.event_id=t.event_id and eki.is_active
where t.status<>'cancelled'
  and (eki.item_type<>'shirt' or (nullif(trim(oi.shirt_type),'') is not null and nullif(trim(oi.shirt_size),'') is not null))
on conflict on constraint participant_kit_items_participant_kit_unique
do update set ticket_id=excluded.ticket_id;

create or replace function public.get_ticket_kit_items(p_ticket_id uuid)
returns table (
  id uuid, kit_item_id uuid, item_name text, item_type text, quantity integer,
  status text, variant_data jsonb, delivered_at timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ticket public.tickets%rowtype; v_org uuid;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where public.tickets.id = p_ticket_id;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select organization_id into v_org from public.events where public.events.id = v_ticket.event_id;
  if not public.user_can_access_organization(auth.uid(), v_org)
    and auth.uid() is distinct from v_ticket.participant_id
    and not exists(select 1 from public.orders o where o.id=v_ticket.order_id and o.user_id=auth.uid()) then
    raise exception 'Usuario sem acesso ao ingresso.';
  end if;
  return query
  select pki.id, pki.kit_item_id, eki.name, eki.item_type, pki.quantity,
    pki.status, pki.variant_data, pki.delivered_at
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id = pki.kit_item_id
  where pki.ticket_id = p_ticket_id
  order by eki.sort_order, pki.created_at;
end;
$$;

create or replace function public.materialize_ticket_kit_items_internal(p_ticket_id uuid, p_source text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype;
  v_item public.event_kit_items%rowtype; v_org uuid; v_link uuid; v_created uuid[] := array[]::uuid[];
  v_existing uuid[] := array[]::uuid[]; v_skipped jsonb := '[]'::jsonb; v_status text := 'reserved';
  v_shirt_type text; v_shirt_size text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para vincular itens.'; end if;
  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.order_item_id is null then raise exception 'Ingresso sem item de pedido vinculado.'; end if;
  select * into v_oi from public.order_items where id = v_ticket.order_item_id for update;
  if not found then raise exception 'Item de pedido do ingresso nao encontrado.'; end if;
  select organization_id into v_org from public.events where id = v_ticket.event_id;
  if not public.user_can_access_organization(v_actor, v_org) then raise exception 'Usuario sem acesso ao evento.'; end if;
  v_shirt_type := nullif(trim(v_oi.shirt_type), ''); v_shirt_size := nullif(trim(v_oi.shirt_size), '');
  if exists (select 1 from public.payments p where p.order_id = v_ticket.order_id and p.payment_status = 'paid') then v_status := 'confirmed'; end if;

  for v_item in select * from public.event_kit_items where event_id = v_ticket.event_id and is_active order by sort_order, created_at loop
    select id into v_link from public.participant_kit_items where ticket_id = p_ticket_id and kit_item_id = v_item.id;
    if v_link is not null then v_existing := array_append(v_existing, v_link); v_link := null; continue; end if;
    if v_item.item_type = 'shirt' and (v_shirt_type is null or v_shirt_size is null) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('kit_item_id',v_item.id,'name',v_item.name,'reason','Informe modelo e tamanho antes de vincular a camiseta.'));
      continue;
    end if;
    insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values (p_ticket_id,v_oi.id,coalesce(v_oi.participant_id,v_ticket.participant_id),v_ticket.event_id,v_org,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object('shirt_type',v_shirt_type,'shirt_size',v_shirt_size) end,
      v_item.quantity_per_participant,v_status)
    on conflict (ticket_id,kit_item_id) where ticket_id is not null do nothing returning id into v_link;
    if v_link is not null then v_created := array_append(v_created,v_link); else
      select id into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id;
      v_existing := array_append(v_existing,v_link);
    end if;
    v_link := null;
  end loop;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values ('ticket_kit_items_materialized','tickets',p_ticket_id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'organization_id',v_org,'ticket_id',p_ticket_id,'participant_id',coalesce(v_oi.participant_id,v_ticket.participant_id),'created_item_ids',v_created,'existing_item_ids',v_existing,'source',p_source,'skipped',v_skipped));
  return jsonb_build_object('ticket_id',p_ticket_id,'created_count',cardinality(v_created),'existing_count',cardinality(v_existing),'skipped_count',jsonb_array_length(v_skipped),'skipped',v_skipped);
end;
$$;

create or replace function public.materialize_ticket_kit_items(p_ticket_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.materialize_ticket_kit_items_internal(p_ticket_id,'operations_manual');
$$;

create or replace function public.materialize_event_ticket_kit_items(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ticket record; v_result jsonb; v_results jsonb := '[]'; v_processed integer:=0; v_created integer:=0; v_skipped integer:=0; v_org uuid;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para vincular itens.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Evento invalido ou sem acesso.'; end if;
  for v_ticket in select id from public.tickets where event_id=p_event_id and status<>'cancelled' order by issued_at loop
    begin
      v_result := public.materialize_ticket_kit_items_internal(v_ticket.id,'operations_batch');
      v_processed:=v_processed+1; v_created:=v_created+coalesce((v_result->>'created_count')::int,0); v_skipped:=v_skipped+coalesce((v_result->>'skipped_count')::int,0);
      v_results:=v_results||jsonb_build_array(v_result);
    exception when others then v_skipped:=v_skipped+1; v_results:=v_results||jsonb_build_array(jsonb_build_object('ticket_id',v_ticket.id,'error',sqlerrm)); end;
  end loop;
  return jsonb_build_object('event_id',p_event_id,'processed_tickets',v_processed,'created_count',v_created,'skipped_count',v_skipped,'results',v_results);
end;
$$;

create or replace function public.deliver_ticket_kit_item(p_ticket_id uuid,p_kit_item_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_link public.participant_kit_items%rowtype; v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_kit public.event_kit_items%rowtype; v_inv public.shirt_inventory%rowtype; v_type text; v_size text;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(),v_link.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_link.status='delivered' then return true; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update;
  if not exists(select 1 from public.payments where order_id=v_ticket.order_id and payment_status='paid') then raise exception 'Pagamento pendente. Entrega bloqueada.'; end if;
  if v_ticket.status='cancelled' or v_oi.status='cancelled' then raise exception 'Ingresso cancelado. Entrega bloqueada.'; end if;
  select * into v_kit from public.event_kit_items where id=p_kit_item_id;
  if v_kit.item_type='shirt' then
    v_type:=coalesce(v_link.variant_data->>'shirt_type',v_oi.shirt_type); v_size:=coalesce(v_link.variant_data->>'shirt_size',v_oi.shirt_size);
    select * into v_inv from public.shirt_inventory where event_id=v_ticket.event_id and shirt_type=v_type and shirt_size=v_size for update;
    if not found or v_inv.reserved_quantity<v_link.quantity then raise exception 'Reserva de camiseta insuficiente para entrega.'; end if;
    update public.shirt_inventory set reserved_quantity=reserved_quantity-v_link.quantity,delivered_quantity=delivered_quantity+v_link.quantity,updated_at=now() where id=v_inv.id;
  end if;
  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values ('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'participant_id',v_link.participant_id,'kit_item_id',p_kit_item_id,'quantity',v_link.quantity));
  return true;
end;
$$;

create or replace function public.deliver_ticket_full_kit(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row record; v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'full_delivery');
  if exists(select 1 from public.event_kit_items eki where eki.event_id=v_ticket.event_id and eki.is_active
    and not exists(select 1 from public.participant_kit_items pki where pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id)) then
    raise exception 'Existem itens aplicaveis com configuracao pendente.';
  end if;
  for v_row in select kit_item_id from public.participant_kit_items where ticket_id=p_ticket_id and status<>'delivered' and status<>'cancelled' loop
    perform public.deliver_ticket_kit_item(p_ticket_id,v_row.kit_item_id);
  end loop;
  return true;
end;
$$;

create or replace function public.undo_ticket_kit_item(p_ticket_id uuid,p_kit_item_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_link public.participant_kit_items%rowtype; v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_kit public.event_kit_items%rowtype; v_inv public.shirt_inventory%rowtype; v_type text; v_size text;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(),v_link.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_link.status<>'delivered' then return true; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update;
  select * into v_kit from public.event_kit_items where id=p_kit_item_id;
  if v_kit.item_type='shirt' then
    v_type:=coalesce(v_link.variant_data->>'shirt_type',v_oi.shirt_type); v_size:=coalesce(v_link.variant_data->>'shirt_size',v_oi.shirt_size);
    select * into v_inv from public.shirt_inventory where event_id=v_ticket.event_id and shirt_type=v_type and shirt_size=v_size for update;
    if found then
      if coalesce(v_inv.delivered_quantity,0)<v_link.quantity then raise exception 'Quantidade entregue inconsistente no estoque.'; end if;
      update public.shirt_inventory set delivered_quantity=delivered_quantity-v_link.quantity,reserved_quantity=reserved_quantity+v_link.quantity,updated_at=now() where id=v_inv.id;
      insert into public.inventory_movements(event_id,inventory_id,movement_type,quantity,notes) values(v_ticket.event_id,v_inv.id,'kit_delivery_undo',v_link.quantity,format('Entrega desfeita para o ingresso %s.',p_ticket_id));
    end if;
  end if;
  update public.participant_kit_items set status='confirmed',delivered_at=null where id=v_link.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_kit_item_delivery_undone','participant_kit_items',v_link.id,v_link.event_id,jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'participant_id',v_link.participant_id,'kit_item_id',p_kit_item_id,'quantity',v_link.quantity));
  return true;
end;
$$;

create or replace function public.undo_ticket_full_kit(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row record; v_found boolean:=false; v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  for v_row in select kit_item_id from public.participant_kit_items where ticket_id=p_ticket_id and status='delivered' loop v_found:=true; perform public.undo_ticket_kit_item(p_ticket_id,v_row.kit_item_id); end loop;
  if not v_found then raise exception 'Nenhum item entregue para desfazer.'; end if;
  return true;
end;
$$;

create or replace function public.change_ticket_shirt(p_ticket_id uuid,p_new_shirt_type text,p_new_shirt_size text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_link public.participant_kit_items%rowtype; v_old public.shirt_inventory%rowtype; v_new public.shirt_inventory%rowtype; v_type text:=nullif(trim(p_new_shirt_type),''); v_size text:=nullif(trim(p_new_shirt_size),''); v_old_type text; v_old_size text; v_qty int:=1; v_delivered boolean:=false; v_enforce boolean; v_owner boolean:=false; v_org uuid; v_deadline timestamptz; v_shirt_config public.event_kit_items%rowtype;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if v_type is null or v_size is null then raise exception 'Tipo e tamanho obrigatorios.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update; if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update; if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select organization_id,shirt_order_deadline into v_org,v_deadline from public.events where id=v_ticket.event_id;
  select exists(select 1 from public.orders o where o.id=v_ticket.order_id and o.user_id=auth.uid())
    or exists(select 1 from public.participants p where p.id=v_oi.participant_id and p.user_id=auth.uid()) into v_owner;
  if not public.current_user_has_permission('inventory.change_participant_shirt') and not v_owner then raise exception 'Sem permissao para trocar camiseta.'; end if;
  if not public.user_can_access_organization(auth.uid(),v_org) and not v_owner then raise exception 'Sem acesso a organizacao.'; end if;
  if v_owner and not public.current_user_has_permission('inventory.change_participant_shirt')
    and v_deadline is not null and now()>v_deadline then raise exception 'Prazo para alteracao de camiseta encerrado.'; end if;
  v_old_type:=v_oi.shirt_type; v_old_size:=v_oi.shirt_size; if v_old_type=v_type and v_old_size=v_size then return true; end if;
  select coalesce(limit_shirt_selection_to_stock,false) into v_enforce from public.events where id=v_ticket.event_id;
  select pki.* into v_link from public.participant_kit_items pki join public.event_kit_items eki on eki.id=pki.kit_item_id where pki.ticket_id=p_ticket_id and eki.item_type='shirt' order by pki.created_at limit 1 for update;
  if found then v_qty:=greatest(v_link.quantity,1); v_delivered:=v_link.status='delivered'; v_old_type:=coalesce(v_link.variant_data->>'shirt_type',v_old_type); v_old_size:=coalesce(v_link.variant_data->>'shirt_size',v_old_size); end if;
  select * into v_old from public.shirt_inventory where event_id=v_ticket.event_id and shirt_type=v_old_type and shirt_size=v_old_size for update;
  select * into v_new from public.shirt_inventory where event_id=v_ticket.event_id and shirt_type=v_type and shirt_size=v_size for update;
  if v_enforce and v_new.id is null then raise exception 'Novo tamanho sem estoque cadastrado.'; end if;
  if v_new.id is not null and v_new.total_quantity-v_new.reserved_quantity-v_new.delivered_quantity<v_qty then raise exception 'Novo tamanho sem saldo.'; end if;
  if v_old.id is not null then if v_delivered then update public.shirt_inventory set delivered_quantity=greatest(delivered_quantity-v_qty,0),updated_at=now() where id=v_old.id; else update public.shirt_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old.id; end if; end if;
  if v_new.id is not null then if v_delivered then update public.shirt_inventory set delivered_quantity=delivered_quantity+v_qty,updated_at=now() where id=v_new.id; else update public.shirt_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new.id; end if; end if;
  update public.order_items set shirt_type=v_type,shirt_size=v_size,updated_at=now() where id=v_oi.id;
  if v_link.id is not null then
    update public.participant_kit_items set variant_data=jsonb_build_object('shirt_type',v_type,'shirt_size',v_size) where id=v_link.id;
  else
    select * into v_shirt_config from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active order by sort_order,created_at limit 1;
    if found then
      insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
      values(p_ticket_id,v_oi.id,v_oi.participant_id,v_ticket.event_id,v_org,v_shirt_config.id,jsonb_build_object('shirt_type',v_type,'shirt_size',v_size),v_shirt_config.quantity_per_participant,case when v_oi.status='confirmed' then 'confirmed' else 'reserved' end);
    end if;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_shirt_changed','tickets',p_ticket_id,v_ticket.event_id,jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'participant_id',coalesce(v_oi.participant_id,v_ticket.participant_id),'previous_type',v_old_type,'previous_size',v_old_size,'next_type',v_type,'next_size',v_size,'kit_item_delivered',v_delivered));
  return true;
end;
$$;

create or replace function public.checkin_ticket_entry(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype; v_participant public.participants%rowtype; v_paid boolean; v_actor_email text;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para realizar check-in.'; end if;
  if p_ticket_id is null then raise exception 'Ingresso obrigatorio.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Sem acesso a organizacao do ingresso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado. Check-in bloqueado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso ja foi utilizado.'; end if;
  if v_ticket.order_item_id is null then raise exception 'Ingresso sem order_item vinculado.'; end if;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update;
  if not found or v_oi.status in ('cancelled','expired','refunded') then raise exception 'Item de pedido invalido para check-in.'; end if;
  select * into v_order from public.orders where id=v_ticket.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  select exists(
    select 1 from public.payments p
    where (p.order_id=v_ticket.order_id or p.id=v_order.payment_id)
      and p.payment_status='paid'
  ) into v_paid;
  if not v_paid then raise exception 'Pagamento pendente. Check-in bloqueado.'; end if;
  update public.tickets set status='used',used_at=now() where id=v_ticket.id;
  if v_oi.participant_id is not null then
    select * into v_participant from public.participants where id=v_oi.participant_id;
    if found and coalesce(v_participant.registration_status,'pending')='cancelled' then raise exception 'Inscricao cancelada. Check-in bloqueado.'; end if;
    if found and v_participant.user_id is not null then
      insert into public.participation_history(event_id,user_id,participant_id,legacy_event_name,event_year,full_name,normalized_name,cpf,email,status,source,manually_verified,created_at,updated_at)
      values(v_participant.event_id,v_participant.user_id,v_participant.id,null,extract(year from coalesce(v_participant.created_at,now()))::integer,
        coalesce(nullif(trim(v_participant.full_name),''),'Participante'),public.normalize_text_for_match(v_participant.full_name),v_participant.cpf,v_participant.email,'confirmed','system',false,now(),now())
      on conflict do nothing;
      perform public.recalculate_customer_loyalty(v_participant.user_id);
    end if;
  end if;
  select lower(email) into v_actor_email from auth.users where id=auth.uid();
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_checkin_entry','tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('actor_user_id',auth.uid(),'actor_email',v_actor_email,'organization_id',v_ticket.organization_id,'ticket_id',v_ticket.id,'order_item_id',v_ticket.order_item_id,'participant_id',v_oi.participant_id,'used_at',now()));
  return true;
end;
$$;

create or replace function public.deliver_items_and_checkin(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') or not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para entrega e check-in.'; end if;
  perform 1 from public.tickets where id=p_ticket_id for update; if not found then raise exception 'Ingresso nao encontrado.'; end if;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'combined_operation');
  if exists(select 1 from public.event_kit_items eki where eki.event_id=(select event_id from public.tickets where id=p_ticket_id) and eki.is_active
    and not exists(select 1 from public.participant_kit_items pki where pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id)) then
    raise exception 'Existem itens aplicaveis com configuracao pendente.';
  end if;
  perform public.deliver_ticket_full_kit(p_ticket_id);
  select public.checkin_ticket_entry(p_ticket_id) into v_ok;
  if v_ok is distinct from true then raise exception 'Nao foi possivel realizar o check-in; a entrega foi revertida.'; end if;
  return true;
end;
$$;

-- Compatibilidade: nunca escolhe entre varios ingressos do mesmo participante.
create or replace function public.resolve_unique_ticket_for_participant(p_participant_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids uuid[];
begin
  select array_agg(id order by id) into v_ids from public.tickets where participant_id=p_participant_id and status<>'cancelled';
  if cardinality(v_ids)=1 then return v_ids[1]; end if;
  if coalesce(cardinality(v_ids),0)=0 then raise exception 'Nenhum ingresso encontrado para o participante.'; end if;
  raise exception 'Mais de um ingresso encontrado para o participante; informe ticket_id.';
end;
$$;

-- Wrappers de transicao. Consumidores legados so funcionam quando o participante
-- identifica exatamente um ingresso; nunca ha escolha por data ou LIMIT 1.
create or replace function public.get_participant_kit_items(p_participant_id uuid)
returns table (
  participant_id uuid, event_id uuid, event_name text, kit_item_id uuid,
  item_name text, item_type text, quantity integer, status text,
  delivered_at timestamptz, variant_data jsonb
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ticket_id uuid;
begin
  v_ticket_id := public.resolve_unique_ticket_for_participant(p_participant_id);
  return query
  select pki.participant_id,pki.event_id,e.name,pki.kit_item_id,eki.name,eki.item_type,
    pki.quantity,pki.status,pki.delivered_at,pki.variant_data
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id=pki.kit_item_id
  join public.events e on e.id=pki.event_id
  where pki.ticket_id=v_ticket_id order by eki.sort_order,eki.created_at;
end;
$$;

create or replace function public.deliver_participant_kit_item(p_participant_id uuid,p_kit_item_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin return public.deliver_ticket_kit_item(public.resolve_unique_ticket_for_participant(p_participant_id),p_kit_item_id); end;
$$;

create or replace function public.deliver_participant_full_kit(p_participant_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin return public.deliver_ticket_full_kit(public.resolve_unique_ticket_for_participant(p_participant_id)); end;
$$;

create or replace function public.undo_participant_kit_item(p_participant_id uuid,p_kit_item_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin return public.undo_ticket_kit_item(public.resolve_unique_ticket_for_participant(p_participant_id),p_kit_item_id); end;
$$;

create or replace function public.undo_participant_full_kit(p_participant_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin return public.undo_ticket_full_kit(public.resolve_unique_ticket_for_participant(p_participant_id)); end;
$$;

create or replace function public.change_participant_shirt(p_participant_id uuid,p_new_shirt_type text,p_new_shirt_size text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin return public.change_ticket_shirt(public.resolve_unique_ticket_for_participant(p_participant_id),p_new_shirt_type,p_new_shirt_size); end;
$$;

create or replace function public.materialize_participant_kit_items(p_ticket_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.materialize_ticket_kit_items(p_ticket_id);
$$;

create or replace function public.materialize_event_participant_kit_items(p_event_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.materialize_event_ticket_kit_items(p_event_id);
$$;

insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
select 'legacy_kit_item_left_unresolved','participant_kit_items',d.participant_kit_item_id,d.event_id,
  jsonb_build_object(
    'participant_kit_item_id',d.participant_kit_item_id,
    'participant_id',d.participant_id,'event_id',d.event_id,'kit_item_id',d.kit_item_id,
    'reason','no_order_or_import_evidence',
    'operation','legacy_kit_item_left_unresolved','source','migration_087'
  )
from ticket_kit_backfill_diagnostic d
join public.participant_kit_items pki on pki.id=d.participant_kit_item_id
where pki.ticket_id is null
  and d.candidate_count=0
  and not exists(select 1 from public.orders o where o.participant_id=d.participant_id and o.event_id=d.event_id)
  and not exists(
    select 1 from public.participation_history ph
    join public.import_batches ib on ib.id=ph.import_batch_id
    where ph.participant_id=d.participant_id and ph.event_id=d.event_id
      and ph.source='import' and ib.event_id=d.event_id
      and ib.import_type='current_event_registrations'
  )
  and not exists(
    select 1 from public.audit_logs al
    where al.action='legacy_kit_item_left_unresolved'
      and al.entity_id=d.participant_kit_item_id
      and al.details->>'source'='migration_087'
  );

do $$
declare v_resolved int; v_ambiguous int; v_without int; v_conflicts int; v_delivered int;
begin
  select count(*) filter(where pki.ticket_id is not null),count(*) filter(where pki.ticket_id is null and d.candidate_count>1),count(*) filter(where pki.ticket_id is null and d.candidate_count=0),count(*) filter(where d.status='delivered')
  into v_resolved,v_ambiguous,v_without,v_delivered
  from ticket_kit_backfill_diagnostic d join public.participant_kit_items pki on pki.id=d.participant_kit_item_id;
  select count(*) into v_conflicts from ticket_kit_uniqueness_conflicts;
  raise notice 'Kit por ticket: resolvidos=%, ambiguos=%, sem candidato=%, conflitos=%, entregues preservados=%',v_resolved,v_ambiguous,v_without,v_conflicts,v_delivered;
end;
$$;

-- Permissoes por catalogo: revoga todos os overloads que realmente existem e
-- concede somente as assinaturas publicas criadas/recriadas acima. Assim nao ha
-- REVOKE/GRANT estatico contra uma assinatura legada ausente.
do $$
declare
  v_function record;
  v_grant_target text;
  v_grant_targets constant text[] := array[
    'public.get_ticket_kit_items(uuid)',
    'public.materialize_ticket_kit_items(uuid)',
    'public.materialize_event_ticket_kit_items(uuid)',
    'public.deliver_ticket_kit_item(uuid,uuid)',
    'public.deliver_ticket_full_kit(uuid)',
    'public.undo_ticket_kit_item(uuid,uuid)',
    'public.undo_ticket_full_kit(uuid)',
    'public.change_ticket_shirt(uuid,text,text)',
    'public.deliver_items_and_checkin(uuid)',
    'public.checkin_ticket_entry(uuid)'
  ];
begin
  for v_function in
    select n.nspname schema_name,p.proname function_name,
      pg_get_function_identity_arguments(p.oid) identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname=any(array[
        'get_ticket_kit_items','materialize_ticket_kit_items_internal',
        'materialize_ticket_kit_items','materialize_event_ticket_kit_items',
        'deliver_ticket_kit_item','deliver_ticket_full_kit',
        'undo_ticket_kit_item','undo_ticket_full_kit','change_ticket_shirt',
        'deliver_items_and_checkin','checkin_ticket_entry',
        'resolve_unique_ticket_for_participant','get_participant_kit_items',
        'deliver_participant_kit_item','deliver_participant_full_kit',
        'undo_participant_kit_item','undo_participant_full_kit',
        'change_participant_shirt','materialize_participant_kit_items',
        'materialize_event_participant_kit_items','deliver_kit'
      ]::name[])
  loop
    execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',
      v_function.schema_name,v_function.function_name,v_function.identity_arguments);
  end loop;

  foreach v_grant_target in array v_grant_targets loop
    if to_regprocedure(v_grant_target) is null then
      raise exception 'Assinatura publica esperada nao existe: %',v_grant_target;
    end if;
    execute format('grant execute on function %s to authenticated',v_grant_target);
  end loop;
end;
$$;

commit;
