-- 093_user_pin_ticket_holder_transfer.sql
-- PIN publico de conta e alteracoes de titularidade por ticket, sem enumeracao.

begin;

alter table public.customer_profiles add column if not exists public_pin text;
alter table public.events
  add column if not exists allow_holder_change boolean not null default false,
  add column if not exists allow_ticket_transfer boolean not null default false;

create unique index if not exists ux_customer_profiles_public_pin on public.customer_profiles(public_pin) where public_pin is not null;
alter table public.customer_profiles drop constraint if exists customer_profiles_public_pin_format;
alter table public.customer_profiles add constraint customer_profiles_public_pin_format check(public_pin is null or public_pin ~ '^[A-Z0-9]{10}$');

create or replace function public.generate_customer_public_pin() returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pin text;
begin
  perform pg_advisory_xact_lock(hashtext('public.customer_profiles.public_pin'));
  loop
    v_pin:=upper(encode(extensions.gen_random_bytes(5),'hex'));
    exit when not exists(select 1 from public.customer_profiles where public_pin=v_pin);
  end loop;
  return v_pin;
end; $$;

do $$
declare v_profile record; v_assigned boolean;
begin
  for v_profile in select user_id from public.customer_profiles where public_pin is null order by user_id loop
    v_assigned:=false;
    while not v_assigned loop
      begin
        update public.customer_profiles set public_pin=public.generate_customer_public_pin() where user_id=v_profile.user_id and public_pin is null;
        v_assigned:=true;
      exception when unique_violation then
        v_assigned:=false;
      end;
    end loop;
  end loop;
end; $$;
alter table public.customer_profiles alter column public_pin set default public.generate_customer_public_pin();
alter table public.customer_profiles alter column public_pin set not null;

create table if not exists public.user_pin_lookup_attempts(
  id bigint generated always as identity primary key,actor_user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now(),found boolean not null default false
);
create index if not exists idx_user_pin_lookup_attempts_actor_time on public.user_pin_lookup_attempts(actor_user_id,attempted_at desc);
revoke all on public.user_pin_lookup_attempts from public,anon,authenticated;

create table if not exists public.ticket_holder_history(
  id uuid primary key default gen_random_uuid(),ticket_id uuid not null references public.tickets(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,event_id uuid not null references public.events(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  operation text not null check(operation in('holder_assigned','ticket_transferred')),
  previous_participant_id uuid references public.participants(id) on delete set null,new_participant_id uuid references public.participants(id) on delete set null,
  previous_user_id uuid references auth.users(id) on delete set null,new_user_id uuid not null references auth.users(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,actor_origin text not null check(actor_origin in('portal','admin')),
  reason text,created_at timestamptz not null default now()
);
alter table public.ticket_holder_history enable row level security;
create policy ticket_holder_history_select on public.ticket_holder_history for select to authenticated using(
  previous_user_id=auth.uid() or new_user_id=auth.uid() or public.user_can_access_organization(auth.uid(),organization_id));
grant select on public.ticket_holder_history to authenticated;
revoke insert,update,delete on public.ticket_holder_history from anon,authenticated;

create or replace function public.get_my_public_pin() returns table(full_name text,public_pin text)
language sql stable security definer set search_path=public,pg_temp as $$
  select cp.full_name,cp.public_pin from public.customer_profiles cp where cp.user_id=auth.uid();
$$;

create or replace function public.find_user_by_public_pin(p_ticket_id uuid,p_pin text) returns table(full_name text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_pin text:=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g'));
  v_ticket public.tickets%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype; v_found boolean:=false;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if (select count(*) from public.user_pin_lookup_attempts where actor_user_id=v_actor and attempted_at>now()-interval '10 minutes')>=15 then raise exception 'Limite de buscas atingido. Tente novamente mais tarde.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled';
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_ticket.order_id;
  select * into v_item from public.order_items where id=v_ticket.order_item_id;
  if v_actor is distinct from v_order.user_id
    and not exists(select 1 from public.participants p where p.id=v_item.participant_id and p.user_id=v_actor)
    and not (public.current_user_has_permission('participants.edit_basic') and public.user_can_access_organization(v_actor,v_ticket.organization_id))
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  if v_pin ~ '^[A-Z0-9]{10}$' then
    select exists(select 1 from public.customer_profiles cp where cp.public_pin=v_pin and coalesce(cp.account_status,'active')='active') into v_found;
  end if;
  insert into public.user_pin_lookup_attempts(actor_user_id,found) values(v_actor,v_found);
  return query select cp.full_name from public.customer_profiles cp
    where v_found and cp.public_pin=v_pin and coalesce(cp.account_status,'active')='active' limit 1;
end; $$;

create or replace function public.change_ticket_holder_by_pin_internal(
  p_ticket_id uuid,p_pin text,p_operation text,p_admin_override boolean default false,p_reason text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype; v_event public.events%rowtype;
  v_target public.customer_profiles%rowtype; v_current public.participants%rowtype; v_target_participant public.participants%rowtype;
  v_pin text:=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g')); v_admin boolean; v_origin text; v_price record; v_priced_gender text; v_target_gender text;
  v_target_email text; v_target_participant_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled' for update; if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update; select * into v_order from public.orders where id=v_ticket.order_id for update; select * into v_event from public.events where id=v_ticket.event_id;
  v_admin:=public.current_user_has_permission('participants.edit_basic') and public.user_can_access_organization(v_actor,v_ticket.organization_id);
  v_origin:=case when v_admin and p_admin_override then 'admin' else 'portal' end;
  if v_origin='portal' and v_actor<>v_order.user_id and not exists(select 1 from public.participants p where p.id=v_oi.participant_id and p.user_id=v_actor) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  if p_operation='holder_assigned' then
    if v_oi.participant_id is not null then raise exception 'Ingresso ja possui titular; use transferencia.'; end if;
    if not v_event.allow_holder_change and not(v_admin and p_admin_override) then raise exception 'Definicao de titular desabilitada para o evento.'; end if;
  elsif p_operation='ticket_transferred' then
    if v_oi.participant_id is null then raise exception 'Ingresso sem titular; use definicao de titular.'; end if;
    if not v_event.allow_ticket_transfer and not(v_admin and p_admin_override) then raise exception 'Transferencia desabilitada para o evento.'; end if;
  else raise exception 'Operacao invalida.'; end if;
  select * into v_target from public.customer_profiles where public_pin=v_pin and coalesce(account_status,'active')='active'; if not found then raise exception 'PIN nao encontrado.'; end if;
  if v_oi.participant_id is not null then select * into v_current from public.participants where id=v_oi.participant_id; end if;
  v_target_gender:=lower(trim(coalesce(v_target.gender,'')));
  select rbp.male_price,rbp.female_price into v_price from public.registration_batch_prices rbp where rbp.batch_id=v_oi.batch_id and rbp.ticket_category_id=v_oi.ticket_category_id;
  if v_price.male_price is distinct from v_price.female_price then
    v_priced_gender:=case when v_oi.unit_price=v_price.male_price and v_oi.unit_price is distinct from v_price.female_price then 'male' when v_oi.unit_price=v_price.female_price and v_oi.unit_price is distinct from v_price.male_price then 'female' end;
    if (v_priced_gender='male' and v_target_gender not in('male','masculino','m')) or (v_priced_gender='female' and v_target_gender not in('female','feminino','f')) or v_priced_gender is null then
      if not(v_admin and p_admin_override) then raise exception 'VALIDACAO_ADMINISTRATIVA: genero do usuario incompativel ou preco original ambiguo.'; end if;
    end if;
  end if;
  if v_current.id is not null and nullif(trim(v_oi.shirt_type),'') is not null and lower(trim(coalesce(v_current.gender,'')))<>v_target_gender and not(v_admin and p_admin_override) then
    raise exception 'VALIDACAO_ADMINISTRATIVA: camiseta existente exige revisao antes da transferencia.';
  end if;
  select count(*) into v_target_participant_count from public.participants where event_id=v_ticket.event_id and user_id=v_target.user_id;
  if v_target_participant_count>1 then
    raise exception 'VALIDACAO_ADMINISTRATIVA: usuario possui multiplos cadastros de participante neste evento.';
  elsif v_target_participant_count=1 then
    select * into strict v_target_participant from public.participants where event_id=v_ticket.event_id and user_id=v_target.user_id;
  else
    select lower(trim(au.email)) into v_target_email from auth.users au where au.id=v_target.user_id;
    if nullif(v_target_email,'') is null then raise exception 'Conta de destino sem e-mail valido para criar participante.'; end if;
    insert into public.participants(event_id,organization_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,shirt_type,shirt_size,registration_status,amount,payment_method,payment_status,ticket_category_id,batch_id)
    values(v_ticket.event_id,v_ticket.organization_id,v_target.user_id,v_target.full_name,v_target.cpf,v_target.birth_date,v_target.gender,v_target.phone,v_target_email,v_target.city,
      coalesce(v_oi.shirt_type,''),coalesce(v_oi.shirt_size,''),'confirmed',v_oi.final_amount,null,'paid',v_oi.ticket_category_id,v_oi.batch_id) returning * into v_target_participant;
  end if;
  if v_current.user_id=v_target.user_id then raise exception 'Usuario ja e o titular do ingresso.'; end if;
  update public.order_items set participant_id=v_target_participant.id,holder_full_name=v_target.full_name,ownership_status=case when p_operation='ticket_transferred' then 'transferred' else 'assigned' end,updated_at=now() where id=v_oi.id;
  update public.tickets set participant_id=v_target_participant.id,ownership_status=case when p_operation='ticket_transferred' then 'transferred' else 'assigned' end where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
  values(v_ticket.id,v_oi.id,v_ticket.event_id,v_ticket.organization_id,p_operation,v_current.id,v_target_participant.id,v_current.user_id,v_target.user_id,v_actor,v_origin,nullif(trim(coalesce(p_reason,'')),''));
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(p_operation,'tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('ticket_id',v_ticket.id,'previous_user_id',v_current.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'actor_origin',v_origin,'reason',nullif(trim(coalesce(p_reason,'')),'')));
  return v_target_participant.id;
end; $$;

create or replace function public.define_ticket_holder_by_pin(p_ticket_id uuid,p_pin text) returns uuid language sql security definer set search_path=public,pg_temp as $$ select public.change_ticket_holder_by_pin_internal(p_ticket_id,p_pin,'holder_assigned',false,null); $$;
create or replace function public.transfer_ticket_by_pin(p_ticket_id uuid,p_pin text) returns uuid language sql security definer set search_path=public,pg_temp as $$ select public.change_ticket_holder_by_pin_internal(p_ticket_id,p_pin,'ticket_transferred',false,null); $$;
create or replace function public.admin_transfer_ticket_by_pin(p_ticket_id uuid,p_pin text,p_reason text,p_operation text default 'ticket_transferred') returns uuid language sql security definer set search_path=public,pg_temp as $$ select public.change_ticket_holder_by_pin_internal(p_ticket_id,p_pin,p_operation,true,p_reason); $$;
create or replace function public.set_event_ticket_holder_rules(p_event_id uuid,p_allow_holder_change boolean,p_allow_ticket_transfer boolean) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_org uuid; begin if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao.'; end if; select organization_id into v_org from public.events where id=p_event_id; if not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Sem acesso.'; end if;
update public.events set allow_holder_change=coalesce(p_allow_holder_change,false),allow_ticket_transfer=coalesce(p_allow_ticket_transfer,false),updated_at=now() where id=p_event_id; return true; end; $$;

revoke all on function public.generate_customer_public_pin() from public,anon,authenticated;
revoke all on function public.assign_order_item_participant(uuid,uuid) from public,anon,authenticated;
revoke all on function public.change_ticket_holder_by_pin_internal(uuid,text,text,boolean,text) from public,anon,authenticated;
revoke all on function public.get_my_public_pin() from public,anon,authenticated;
revoke all on function public.find_user_by_public_pin(uuid,text) from public,anon,authenticated;
revoke all on function public.define_ticket_holder_by_pin(uuid,text) from public,anon,authenticated;
revoke all on function public.transfer_ticket_by_pin(uuid,text) from public,anon,authenticated;
revoke all on function public.admin_transfer_ticket_by_pin(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.set_event_ticket_holder_rules(uuid,boolean,boolean) from public,anon,authenticated;
grant execute on function public.get_my_public_pin() to authenticated;
grant execute on function public.find_user_by_public_pin(uuid,text) to authenticated;
grant execute on function public.define_ticket_holder_by_pin(uuid,text) to authenticated;
grant execute on function public.transfer_ticket_by_pin(uuid,text) to authenticated;
grant execute on function public.admin_transfer_ticket_by_pin(uuid,text,text,text) to authenticated;
grant execute on function public.set_event_ticket_holder_rules(uuid,boolean,boolean) to authenticated;

commit;
