-- BUG 1: uma mesma pessoa podia terminar como titular de dois ingressos ativos
-- no mesmo evento pelo checkout multi-ingressos publico ("Este ingresso e para
-- mim"). Causa raiz: create_multi_ticket_order_checkout_legacy atribui
-- ownership_status='assigned' e participant_id=<comprador> ao primeiro item via
-- INSERT simples, sem nunca chamar assert_ticket_holder_contact_available (a
-- mesma checagem canonica, atomica e contact-first ja usada por
-- admin_set_ticket_holder_contact, change_ticket_holder_by_pin_for_owner e
-- issue_manual_ticket_batch). O trigger enforce_order_item_holder_contact_uniqueness
-- so dispara em UPDATE de order_items (nunca em INSERT), e o trigger equivalente
-- em tickets so protege no momento da emissao do ingresso -- tarde demais: o
-- pedido "reservado" duplicado ja existe, e uma reserva paga primeiro bloquearia
-- a segunda so no pagamento, nao no checkout. Alem disso, nem order_items nem
-- participants recebiam registration_contact_id para o item "self": a
-- titularidade do comprador nunca era ancorada em um cadastro global.
--
-- A correcao adiciona, na mesma transacao do checkout (portanto atomica), a
-- resolucao/criacao do registration_contacts do comprador por (organization_id,
-- cpf) -- a chave natural ja usada em toda a arquitetura contact-first -- e
-- reusa assert_ticket_holder_contact_available antes de confirmar a
-- titularidade. Se a pessoa ja for titular de outro ingresso ativo no evento, a
-- excecao aborta a transacao inteira (pedido, pagamento e reserva de estoque
-- nunca se tornam visiveis).
begin;

create or replace function public.materialize_self_checkout_holder(
  p_order_id uuid,p_assign_first_to_buyer boolean,p_buyer_cpf text,p_buyer_full_name text,
  p_buyer_birth_date date,p_buyer_gender text,p_buyer_phone text,p_buyer_email text,p_buyer_city text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_contact public.registration_contacts%rowtype; v_cpf text:=regexp_replace(coalesce(p_buyer_cpf,''),'\D','','g');
  v_ticket_id uuid;
begin
  if not coalesce(p_assign_first_to_buyer,false) then return; end if;
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;

  select * into v_order from public.orders where id=p_order_id and user_id=v_actor for update;
  if not found then raise exception 'Pedido do checkout nao encontrado.'; end if;

  select * into v_item from public.order_items where order_id=v_order.id and item_position=1
    and ownership_status='assigned' for update;
  if not found then return; end if;
  if v_item.registration_contact_id is not null then return; end if;
  if length(v_cpf)<>11 then raise exception 'CPF do comprador invalido para titularidade automatica.'; end if;

  -- Mesmo lock por (organizacao, cpf) usado em materialize_named_checkout_holders:
  -- serializa tentativas concorrentes de resolver/criar o mesmo cadastro global.
  perform pg_advisory_xact_lock(hashtextextended(v_order.organization_id::text||':cpf:'||v_cpf,0));

  select * into v_contact from public.registration_contacts
    where organization_id=v_order.organization_id and cpf=v_cpf for update;
  if not found then
    insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city,created_by)
    values(v_order.organization_id,trim(p_buyer_full_name),v_cpf,p_buyer_birth_date,
      nullif(trim(coalesce(p_buyer_gender,'')),''),regexp_replace(coalesce(p_buyer_phone,''),'\D','','g'),
      lower(trim(coalesce(p_buyer_email,''))),nullif(trim(coalesce(p_buyer_city,'')),''),v_actor)
    returning * into v_contact;
  end if;

  -- O ticket deste proprio item (se ja emitido, ex.: pagamento courtesy/gratuito
  -- que confirma na hora, via confirm_order_item_and_issue_ticket) PRECISA ser
  -- excluido da checagem. Motivo confirmado por reproducao direta (nao e uma
  -- suposicao): o trigger BEFORE INSERT trg_sync_participant_registration_contact
  -- (public.sync_participant_registration_contact), que ja existe desde a
  -- arquitetura contact-first original, resolve/cria o registration_contacts do
  -- comprador por (organization_id, cpf) e grava em participants.registration_contact_id
  -- no INSTANTE em que o participante-ancora e inserido -- MUITO antes deste
  -- ponto, dentro de create_multi_ticket_order_checkout_legacy. Ou seja, quando
  -- o pagamento e courtesy/gratuito e o ticket deste item ja foi emitido,
  -- participants.registration_contact_id do titular JA e o mesmo v_contact.id
  -- que estamos prestes a confirmar. Sem excluir o ticket deste proprio item,
  -- registration_contact_has_active_ticket encontra esse ticket -- que ainda
  -- nao e "outro" ingresso, e sim o PROPRIO -- e rejeita com
  -- HOLDER_ALREADY_HAS_TICKET_FOR_EVENT ja na primeira compra self de qualquer
  -- pessoa (bug reproduzido e corrigido; NUNCA usar p_ticket_id=null aqui).
  select id into v_ticket_id from public.tickets where order_item_id=v_item.id;

  -- Checagem canonica, atomica: aborta a transacao inteira (pedido, pagamento e
  -- reserva de estoque) se esta pessoa ja for titular de OUTRO ingresso ativo.
  perform public.assert_ticket_holder_contact_available(v_ticket_id,v_order.event_id,v_contact.id);

  update public.order_items set registration_contact_id=v_contact.id,holder_full_name=v_contact.full_name,
    updated_at=now() where id=v_item.id;
  if v_item.participant_id is not null then
    update public.participants set registration_contact_id=v_contact.id
      where id=v_item.participant_id and registration_contact_id is null;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('self_ticket_holder_materialized','order_items',v_item.id,v_order.event_id,jsonb_build_object(
    'actor_user_id',v_actor,'order_id',v_order.id,'order_item_id',v_item.id,'registration_contact_id',v_contact.id));
end; $$;

revoke all on function public.materialize_self_checkout_holder(uuid,boolean,text,text,date,text,text,text,text)
  from public,anon,authenticated;

create or replace function public.create_multi_ticket_order_checkout(
  p_event_id uuid,p_ticket_category_id uuid,p_gender text,p_quantity integer,p_payment_method text,
  p_coupon_code text default null,p_shirt_type text default null,p_shirt_size text default null,
  p_buyer_full_name text default null,p_buyer_cpf text default null,p_buyer_birth_date date default null,
  p_buyer_gender text default null,p_buyer_phone text default null,p_buyer_email text default null,p_buyer_city text default null,
  p_assign_first_to_buyer boolean default true,p_items jsonb default '[]'::jsonb,p_limit_per_order integer default 10,
  p_notes text default null,p_client_request_id text default null
) returns table(order_id uuid,payment_id uuid,order_number text,payment_status text,reservation_expires_at timestamptz,
  item_count integer,amount numeric,discount_amount numeric,final_amount numeric)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result record;
begin
  select * into v_result from public.create_multi_ticket_order_checkout_inventory_legacy(
    p_event_id,p_ticket_category_id,p_gender,p_quantity,p_payment_method,p_coupon_code,p_shirt_type,p_shirt_size,
    p_buyer_full_name,p_buyer_cpf,p_buyer_birth_date,p_buyer_gender,p_buyer_phone,p_buyer_email,p_buyer_city,
    p_assign_first_to_buyer,p_items,p_limit_per_order,p_notes,p_client_request_id) limit 1;
  perform public.materialize_self_checkout_holder(v_result.order_id,p_assign_first_to_buyer,p_buyer_cpf,
    p_buyer_full_name,p_buyer_birth_date,p_buyer_gender,p_buyer_phone,p_buyer_email,p_buyer_city);
  perform public.materialize_named_checkout_holders(v_result.order_id,p_items);
  return query select v_result.order_id,v_result.payment_id,v_result.order_number,v_result.payment_status,
    v_result.reservation_expires_at,v_result.item_count,v_result.amount,v_result.discount_amount,v_result.final_amount;
end; $$;

revoke all on function public.create_multi_ticket_order_checkout(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.create_multi_ticket_order_checkout(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) to authenticated;

-- Leitura para o frontend decidir, ANTES de mostrar "Este ingresso e para mim",
-- se o comprador autenticado ja e titular de outro ingresso ativo no evento.
-- Resolve pelo mesmo par (organization_id, cpf) que materialize_self_checkout_holder
-- usa para materializar -- nunca por nome, e-mail ou telefone.
create or replace function public.get_public_buyer_ticket_holder_status(p_event_id uuid)
returns table(already_holds_active_ticket boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_org uuid; v_cpf text; v_contact_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if v_org is null then raise exception 'Evento nao encontrado.'; end if;

  select regexp_replace(coalesce(cpf,''),'\D','','g') into v_cpf
  from public.customer_profiles where user_id=v_actor;

  if v_cpf is null or length(v_cpf)<>11 then
    return query select false;
    return;
  end if;

  select id into v_contact_id from public.registration_contacts where organization_id=v_org and cpf=v_cpf;
  if v_contact_id is null then
    return query select false;
    return;
  end if;

  return query select public.registration_contact_has_active_ticket(p_event_id,v_contact_id);
end; $$;

revoke all on function public.get_public_buyer_ticket_holder_status(uuid) from public,anon;
grant execute on function public.get_public_buyer_ticket_holder_status(uuid) to authenticated;

commit;
