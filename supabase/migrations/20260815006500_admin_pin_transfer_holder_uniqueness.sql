-- BUG 2 (mesma investigacao de titularidade unica): das 4 rotas que atribuem
-- titular a um ingresso -- admin_set_ticket_holder_contact ("Definir titular"
-- direto), change_ticket_holder_by_pin_for_owner (self-service, usada por
-- define_ticket_holder_by_pin/transfer_ticket_by_pin), materialize_self_checkout_holder
-- (checkout publico, corrigida na migration anterior) e change_ticket_holder_by_pin_internal
-- (transferencia/definicao ADMINISTRATIVA via PIN, usada por admin_transfer_ticket_by_pin) --
-- apenas esta ultima nunca chamava assert_ticket_holder_contact_available.
-- Ela resolve o titular de destino por participants.user_id (arquitetura antiga,
-- anterior ao contact-first), nunca por registration_contact_id, entao um
-- administrador podia transferir/definir um ingresso para uma pessoa que ja
-- fosse titular de outro ingresso ativo no mesmo evento sob um participants.user_id
-- diferente (ou sem cadastro previamente vinculado a este user_id neste evento) e
-- nada bloqueava.
--
-- A correcao resolve o registration_contacts do PIN de destino pela mesma chave
-- natural (organization_id, cpf) usada em toda a arquitetura contact-first e
-- reusa a checagem canonica antes de confirmar a troca -- exatamente como
-- admin_set_ticket_holder_contact ja faz. Quando o PIN de destino nao tem CPF
-- vinculado a nenhum registration_contacts da organizacao (cadastro ainda nao
-- unificado), nao ha titularidade contact-first para verificar e a funcao segue
-- seu comportamento anterior (nunca bloqueia por uma checagem que nao pode ser
-- feita) -- mesma convencao ja usada por get_public_buyer_ticket_holder_status.
begin;

create or replace function public.change_ticket_holder_by_pin_internal(
  p_ticket_id uuid,p_pin text,p_operation text,p_admin_override boolean default false,p_reason text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype; v_event public.events%rowtype;
  v_target public.customer_profiles%rowtype; v_current public.participants%rowtype; v_target_participant public.participants%rowtype;
  v_pin text:=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g')); v_admin boolean; v_origin text; v_price record; v_priced_gender text; v_target_gender text;
  v_target_email text; v_target_participant_count integer; v_target_contact_id uuid;
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

  -- Checagem canonica, atomica: resolve o cadastro global do PIN de destino por
  -- (organization_id, cpf) -- nunca por nome/e-mail/telefone -- e aborta a
  -- transacao inteira se essa pessoa ja for titular de outro ingresso ativo
  -- neste evento. Sem CPF vinculado a um registration_contacts desta
  -- organizacao, nao ha titularidade contact-first para verificar.
  select id into v_target_contact_id from public.registration_contacts
    where organization_id=v_ticket.organization_id and cpf=regexp_replace(coalesce(v_target.cpf,''),'\D','','g');
  if v_target_contact_id is not null then
    perform public.assert_ticket_holder_contact_available(v_ticket.id,v_ticket.event_id,v_target_contact_id);
  end if;

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
    insert into public.participants(event_id,organization_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,shirt_type,shirt_size,registration_status,ticket_category_id,batch_id)
    values(v_ticket.event_id,v_ticket.organization_id,v_target.user_id,v_target.full_name,v_target.cpf,v_target.birth_date,v_target.gender,v_target.phone,v_target_email,v_target.city,
      nullif(trim(coalesce(v_oi.shirt_type,'')),''),nullif(trim(coalesce(v_oi.shirt_size,'')),''),'confirmed',v_oi.ticket_category_id,v_oi.batch_id) returning * into v_target_participant;
  end if;
  if v_current.user_id=v_target.user_id then raise exception 'Usuario ja e o titular do ingresso.'; end if;
  update public.order_items set participant_id=v_target_participant.id,holder_full_name=v_target.full_name,ownership_status=case when p_operation='ticket_transferred' then 'transferred' else 'assigned' end,updated_at=now() where id=v_oi.id;
  update public.tickets set participant_id=v_target_participant.id where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
  values(v_ticket.id,v_oi.id,v_ticket.event_id,v_ticket.organization_id,p_operation,v_current.id,v_target_participant.id,v_current.user_id,v_target.user_id,v_actor,v_origin,nullif(trim(coalesce(p_reason,'')),''));
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(p_operation,'tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('ticket_id',v_ticket.id,'previous_user_id',v_current.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'actor_origin',v_origin,'reason',nullif(trim(coalesce(p_reason,'')),'')));
  return v_target_participant.id;
end; $$;

revoke all on function public.change_ticket_holder_by_pin_internal(uuid,text,text,boolean,text) from public,anon,authenticated;

commit;
