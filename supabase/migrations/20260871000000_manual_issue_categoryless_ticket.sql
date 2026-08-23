-- ============================================================================
-- BUG: emissao manual de ingresso (issue_manual_ticket_batch) exige categoria
-- ativa mesmo em evento "ingresso unico" (0 categorias ativas), enquanto o
-- checkout publico (get_registration_pricing_preview, 20260865000000) ja
-- suporta esse modelo adaptativo desde a introducao de multiplos lotes de
-- ingresso unico. create_manual_registration_order e
-- create_manual_unassigned_ticket_order (chamadas por issue_manual_ticket_batch)
-- exigiam p_ticket_category_id NOT NULL e uma linha ativa em ticket_categories
-- -- nunca foram atualizadas quando o modelo adaptativo foi introduzido.
--
-- Nao ha NENHUMA constraint de banco (FK/NOT NULL) exigindo categoria em
-- order_items/participants/tickets -- ticket_category_id ja e nullable nessas
-- tabelas. A exigencia era 100% regra de negocio destas duas funcoes.
--
-- ATENCAO (armadilha ja caida uma vez ao escrever este fix): o dump
-- 20260815001914_remote_schema.sql contem uma versao de
-- create_manual_registration_order que NAO e a que esta live hoje. A
-- migration 20260815004500_close_phase2_lint_blockers.sql (timestamp maior,
-- aplicada depois do dump) redefiniu essa funcao pra usar
-- resolve_import_registration_contact (fluxo contact-first) e
-- ensure_ticket_kit_items -- confirmado empiricamente consultando o schema
-- REST ao vivo (/rest/v1/, paths /rpc/resolve_import_registration_contact e
-- /rpc/ensure_ticket_kit_items existem). Esta migration parte da versao de
-- 20260815004500, nao da versao do dump -- partir do dump teria revertido
-- silenciosamente o vinculo de registration_contact_id e a entrega de kit
-- nos ingressos emitidos manualmente. create_manual_unassigned_ticket_order
-- e issue_manual_ticket_batch NUNCA foram redefinidas fora do dump (unica
-- ocorrencia de "create or replace function public.<nome>" em todo
-- supabase/migrations/*.sql e a do proprio dump) -- para essas duas, a
-- versao do dump e de fato a live, sem armadilha.
--
-- CORRECAO: mesmo corte adaptativo 0/1+ ja usado por
-- get_registration_pricing_preview -- p_ticket_category_id null so e aceito
-- quando o evento NAO tem nenhuma categoria ativa; se tiver, categoria volta
-- a ser obrigatoria (nunca decide sozinho qual usar). No ramo sem categoria,
-- o lote precisa ser um lote de ingresso unico de verdade (identificado pela
-- mesma premissa ja usada em todo o resto do sistema: ausencia de linhas em
-- registration_batch_prices) e o preco vem direto de
-- registration_batches.male_price/female_price, igual ao checkout.
--
-- Diferente do checkout, a emissao manual sempre recebe um LOTE ESCOLHIDO
-- pelo operador (nao deve ser trocado por auto-resolucao). Isso colide com
-- o trigger trg_assign_single_ticket_batch_by_gender (20260865000000), que
-- reescreve batch_id sempre que ticket_category_id e null e pricing_gender
-- e informado -- exatamente o caso do ingresso emitido manualmente sem
-- categoria. Corrigido com uma flag de sessao local a transacao
-- (app.manual_ticket_batch_override), no mesmo padrao ja usado por
-- issue_manual_ticket_batch para app.administrative_ticket_issue_actor: as
-- duas RPCs de escrita a ligam antes do insert em order_items, e o trigger
-- passa a respeitar o batch_id ja definido quando ela estiver ligada. O
-- checkout nunca liga essa flag, entao seu comportamento de auto-resolucao
-- (correcao do bug documentado em 20260865000000) fica inalterado.
--
-- pricing_gender (coluna adicionada em 20260846000000, depois de ambas as
-- funcoes -- nenhuma das duas gravava esse campo ate agora) passa a ser
-- gravado nos dois casos: sem isso, ingressos manuais de ingresso unico nao
-- contariam corretamente na capacidade por genero de
-- resolve_single_ticket_batch_for_gender (que filtra por pricing_gender no
-- modo com split de genero).
-- ============================================================================

create or replace function public.assign_single_ticket_batch_by_gender()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch public.registration_batches%rowtype;
begin
  if coalesce(current_setting('app.manual_ticket_batch_override', true), '') = 'true' then
    return new;
  end if;

  if new.ticket_category_id is not null or new.pricing_gender is null then
    return new;
  end if;

  select * into v_batch
  from public.resolve_single_ticket_batch_for_gender(new.event_id, new.pricing_gender);

  if not found or v_batch.id is null then
    raise exception 'Lote esgotado para o ingresso unico (%).', new.pricing_gender;
  end if;

  new.batch_id := v_batch.id;
  return new;
end; $$;


create or replace function public.create_manual_registration_order(
  p_event_id uuid,p_ticket_category_id uuid,p_batch_id uuid,p_full_name text,p_cpf text,p_birth_date date,p_gender text,
  p_phone text,p_email text,p_city text,p_shirt_type text,p_shirt_size text,p_payment_method text,p_notes text default null
) returns table(participant_id uuid,order_id uuid,order_item_id uuid,payment_id uuid,ticket_id uuid,full_name text,batch_name text,
  base_amount numeric,discount_amount numeric,final_amount numeric,payment_status text,reservation_expires_at timestamptz,shirt_type text,shirt_size text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_contact public.registration_contacts%rowtype; v_contact_result jsonb;
  v_participant public.participants%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype; v_payment public.payments%rowtype;
  v_batch public.registration_batches%rowtype;
  v_base numeric; v_batch_name text; v_ticket uuid;
  v_type text:=nullif(trim(coalesce(p_shirt_type,'')),''); v_size text:=nullif(trim(coalesce(p_shirt_size,'')),'');
  v_pricing_gender_key text:=lower(trim(coalesce(p_gender,'')));
  v_pricing_gender text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para criar inscricao manual.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;

  v_pricing_gender := case
    when v_pricing_gender_key in ('feminino','female','f') then 'female'
    when v_pricing_gender_key in ('masculino','male','m') then 'male'
    else null
  end;
  if v_pricing_gender is null then raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.'; end if;

  if p_ticket_category_id is not null then
    if not exists(select 1 from public.ticket_categories tc where tc.id=p_ticket_category_id and tc.event_id=p_event_id and tc.is_active) then
      raise exception 'Categoria invalida.';
    end if;
    select rb.name into v_batch_name from public.registration_batches rb where rb.id=p_batch_id and rb.event_id=p_event_id;
    if not found then raise exception 'Lote invalido.'; end if;
    select case when v_pricing_gender='female' then rbp.female_price else rbp.male_price end into v_base
      from public.registration_batch_prices rbp where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
    if v_base is null then raise exception 'Preco nao configurado.'; end if;
  else
    if exists(select 1 from public.ticket_categories where event_id=p_event_id and is_active=true) then
      raise exception 'Este evento usa categorias ativas; selecione uma categoria de acesso.';
    end if;
    select * into v_batch from public.registration_batches rb
    where rb.id=p_batch_id and rb.event_id=p_event_id
      and not exists(select 1 from public.registration_batch_prices rbp where rbp.batch_id=rb.id);
    if not found then raise exception 'Lote invalido para ingresso unico (sem categoria) neste evento.'; end if;
    v_batch_name := v_batch.name;
    v_base := case when v_pricing_gender='female' then v_batch.female_price else v_batch.male_price end;
  end if;

  if exists(select 1 from public.event_kit_items eki where eki.event_id=p_event_id and eki.item_type='shirt' and eki.is_active) and (v_type is null or v_size is null) then
    raise exception 'Camiseta obrigatoria.';
  end if;

  v_contact_result:=public.resolve_import_registration_contact(v_event.organization_id,null,p_full_name,p_cpf,p_birth_date,p_gender,p_phone,p_email,p_city);
  select * into strict v_contact from public.registration_contacts where id=(v_contact_result->>'registration_contact_id')::uuid for update;
  select * into v_participant from public.participants p where p.event_id=p_event_id and p.registration_contact_id=v_contact.id for update;
  if not found then
    insert into public.participants(event_id,organization_id,registration_contact_id,full_name,cpf,birth_date,gender,phone,email,city,registration_status,reservation_status,notes)
    values(p_event_id,v_event.organization_id,v_contact.id,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,v_contact.phone,v_contact.email,v_contact.city,
      'pending','pending',nullif(trim(coalesce(p_notes,'')),'')) returning * into v_participant;
  end if;

  insert into public.orders(user_id,participant_id,event_id,organization_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
    values(v_actor,v_participant.id,p_event_id,v_event.organization_id,public.generate_order_number(),'confirmed',v_base,v_base,0,'account',now()) returning * into v_order;

  perform set_config('app.manual_ticket_batch_override','true',true);

  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,ownership_status,holder_full_name,ticket_category_id,batch_id,pricing_gender,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status) values(v_order.id,p_event_id,v_participant.id,v_contact.id,'assigned',v_contact.full_name,p_ticket_category_id,p_batch_id,
    v_pricing_gender,v_type,v_size,1,v_base,v_base,0,'confirmed') returning * into v_item;

  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at)
    values(v_participant.id,p_event_id,v_event.organization_id,v_order.id,v_base,v_base,0,lower(trim(p_payment_method)),'paid',now()) returning * into v_payment;
  update public.orders set payment_id=v_payment.id where id=v_order.id;
  v_ticket:=public.confirm_order_item_and_issue_ticket(v_item.id);
  perform public.ensure_ticket_kit_items(v_ticket);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('manual_registration_order_created','orders',v_order.id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'registration_contact_id',v_contact.id,'participant_projection_id',v_participant.id,'order_item_id',v_item.id,
      'ticket_category_id',p_ticket_category_id,'batch_id',p_batch_id,'payment_id',v_payment.id,'ticket_id',v_ticket,'category_owner','order_items'));
  return query select v_participant.id,v_order.id,v_item.id,v_payment.id,v_ticket,v_contact.full_name,v_batch_name,v_base,v_base,0::numeric,
    v_payment.payment_status,null::timestamptz,coalesce(v_item.shirt_type,''),coalesce(v_item.shirt_size,'');
end; $$;


CREATE OR REPLACE FUNCTION "public"."create_manual_unassigned_ticket_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_item_id" "uuid", "payment_id" "uuid", "ticket_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid();
  v_event public.events%rowtype;
  v_batch public.registration_batches%rowtype;
  v_base_amount numeric;
  v_pricing_gender_key text:=lower(trim(coalesce(p_pricing_gender,'')));
  v_pricing_gender text;
  v_order_id uuid;
  v_item_id uuid;
  v_payment_id uuid;
  v_ticket_id uuid;
  v_inventory public.shirt_inventory%rowtype;
  v_has_shirt_item boolean;
  v_enforce_physical_stock boolean;
  v_shirt_type text;
  v_shirt_size text;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para emitir ingresso.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if p_batch_id is null then raise exception 'Lote obrigatorio.'; end if;

  v_pricing_gender := case
    when v_pricing_gender_key in ('feminino','female','f') then 'female'
    when v_pricing_gender_key in ('masculino','male','m') then 'male'
    else null
  end;
  if v_pricing_gender is null then
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  if p_ticket_category_id is not null then
    if not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=p_event_id and is_active) then
      raise exception 'Categoria invalida para o evento.';
    end if;
    if not exists(select 1 from public.registration_batches where id=p_batch_id and event_id=p_event_id) then
      raise exception 'Lote nao pertence ao evento selecionado.';
    end if;

    select round((case when v_pricing_gender='female' then rbp.female_price else rbp.male_price end),2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
    if v_base_amount is null then
      raise exception 'Nao ha preco configurado para essa combinacao de categoria e lote.';
    end if;
  else
    if exists(select 1 from public.ticket_categories where event_id=p_event_id and is_active=true) then
      raise exception 'Este evento usa categorias ativas; selecione uma categoria de acesso.';
    end if;

    select * into v_batch from public.registration_batches rb
    where rb.id=p_batch_id and rb.event_id=p_event_id
      and not exists(select 1 from public.registration_batch_prices rbp where rbp.batch_id=rb.id);
    if not found then
      raise exception 'Lote invalido para ingresso unico (sem categoria) neste evento.';
    end if;
    v_base_amount := round((case when v_pricing_gender='female' then v_batch.female_price else v_batch.male_price end),2);
  end if;

  select exists(
    select 1 from public.event_kit_items eki
    where eki.event_id=p_event_id and eki.item_type='shirt' and eki.is_active=true
  ) into v_has_shirt_item;
  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock,false);

  if v_has_shirt_item then
    v_shirt_type := nullif(trim(coalesce(p_shirt_type,'')),'');
    v_shirt_size := nullif(trim(coalesce(p_shirt_size,'')),'');
    if v_shirt_type is null or v_shirt_size is null then
      raise exception 'Camiseta obrigatoria para este evento.';
    end if;
  else
    v_shirt_type := null;
    v_shirt_size := null;
  end if;

  insert into public.orders(user_id,participant_id,event_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
  values(v_actor,null,p_event_id,public.generate_order_number(),'confirmed',
    v_base_amount,v_base_amount,0,'account',now()) returning id into v_order_id;

  perform set_config('app.manual_ticket_batch_override','true',true);

  insert into public.order_items(order_id,event_id,participant_id,ownership_status,ticket_category_id,batch_id,pricing_gender,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status,reservation_expires_at)
  values(v_order_id,p_event_id,null,'unassigned',p_ticket_category_id,p_batch_id,v_pricing_gender,v_shirt_type,v_shirt_size,
    1,v_base_amount,v_base_amount,0,
    'confirmed',null) returning id into v_item_id;

  if v_has_shirt_item and v_enforce_physical_stock then
    select * into v_inventory from public.shirt_inventory
    where event_id=p_event_id and shirt_type=v_shirt_type and shirt_size=v_shirt_size for update;
    if not found or v_inventory.total_quantity-v_inventory.reserved_quantity-v_inventory.delivered_quantity<=0 then
      raise exception 'Estoque indisponivel para o modelo/tamanho selecionado.';
    end if;
    update public.shirt_inventory set reserved_quantity=reserved_quantity+1,updated_at=now() where id=v_inventory.id;
  end if;

  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at,expires_at)
  values(null,p_event_id,v_event.organization_id,v_order_id,v_base_amount,v_base_amount,0,
    lower(trim(p_payment_method)),'paid',now(),null) returning id into v_payment_id;
  update public.orders set payment_id=v_payment_id where id=v_order_id;
  v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item_id);

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('manual_unassigned_ticket_order_created','orders',v_order_id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'order_item_id',v_item_id,
      'ticket_category_id',p_ticket_category_id,'batch_id',p_batch_id,
      'payment_id',v_payment_id,'ticket_id',v_ticket_id,
      'reason',lower(trim(p_payment_method)),'notes',v_notes));

  return query select v_order_id,v_item_id,v_payment_id,v_ticket_id;
end;
$$;
