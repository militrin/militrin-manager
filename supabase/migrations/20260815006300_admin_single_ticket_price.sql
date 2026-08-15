-- Fecha a experiencia administrativa do checkout adaptativo: permite configurar
-- o preco do "Ingresso unico" sem exigir categoria nem chamada manual de RPC, e
-- alinha o gatilho de preco-nao-confirmado a categorias ATIVAS (nao a linhas
-- historicas de ticket_categories). Categoria desativada ou removida volta a
-- exigir confirmacao consciente do preco do ingresso unico, como pedido.
begin;

-- Antes contava toda linha de ticket_categories (mesmo desativada), bloqueando
-- com TICKET_CATEGORY_UNAVAILABLE um evento que o operador esvaziou de proposito
-- para virar ingresso unico. Agora conta apenas categorias ATIVAS: sem nenhuma
-- ativa, o evento cai no fluxo de preco confirmado; com categoria ativa porem
-- esgotada/sem preco no lote atual, continua bloqueado (nao vira ingresso unico
-- por acidente).
create or replace function public.get_registration_pricing_preview(
  p_gender text,p_coupon_code text default null,p_event_id uuid default null,p_ticket_category_id uuid default null
) returns table(batch_id uuid,batch_name text,sequence_number integer,base_amount numeric,discount_amount numeric,
  final_amount numeric,remaining_slots integer,coupon_message text,coupon_type text,discount_percent numeric)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event_id uuid:=p_event_id; v_batch public.registration_batches%rowtype; v_coupon record;
  v_gender text:=lower(trim(coalesce(p_gender,''))); v_base numeric; v_discount numeric:=0; v_final numeric;
  v_confirmed integer:=0; v_eligible_categories integer:=0; v_active_categories integer:=0; v_remaining integer;
begin
  if v_event_id is null then
    select e.id into v_event_id from public.events e where e.is_active order by e.created_at desc limit 1;
  end if;
  if v_event_id is null then raise exception 'Nenhum evento ativo encontrado.'; end if;

  if p_ticket_category_id is not null then
    return query select * from public.get_registration_pricing_preview_categorized_legacy(
      p_gender,p_coupon_code,v_event_id,p_ticket_category_id);
    return;
  end if;

  select count(*) into v_active_categories from public.ticket_categories tc where tc.event_id=v_event_id and tc.is_active=true;

  select count(*) into v_eligible_categories from public.get_event_ticket_categories(v_event_id) tc
  where tc.is_active and (tc.available_slots is null or tc.available_slots>0) and tc.current_batch_id is not null;
  if v_eligible_categories>0 then
    raise exception using errcode='P0001',message='TICKET_CATEGORY_REQUIRED',
      detail=jsonb_build_object('code','TICKET_CATEGORY_REQUIRED','message','Selecione uma categoria de ingresso.')::text;
  end if;

  if v_active_categories>0 then
    raise exception using errcode='P0001',message='TICKET_CATEGORY_UNAVAILABLE',
      detail=jsonb_build_object('code','TICKET_CATEGORY_UNAVAILABLE',
        'message','Nenhuma categoria de ingresso esta disponivel neste momento.')::text;
  end if;

  select * into v_batch from public.registration_batches rb where rb.event_id=v_event_id and rb.is_active
    and (rb.ends_at is null or now()<=rb.ends_at) order by rb.sequence_number limit 1;
  if not found then raise exception 'Nenhum lote ativo configurado para o evento.'; end if;

  if not coalesce(v_batch.flat_price_confirmed,false) then
    raise exception using errcode='P0001',message='BATCH_FLAT_PRICE_NOT_CONFIRMED',
      detail=jsonb_build_object('code','BATCH_FLAT_PRICE_NOT_CONFIRMED',
        'message','O preco do ingresso unico deste lote ainda nao foi confirmado pela organizacao.')::text;
  end if;

  select count(*)::integer into v_confirmed from public.order_items oi
  join public.orders o on o.id=oi.order_id
  where oi.event_id=v_event_id and oi.batch_id=v_batch.id and oi.ticket_category_id is null
    and oi.status='confirmed' and o.status='confirmed';
  if v_confirmed>=v_batch.max_confirmed_registrations then
    raise exception 'Lote esgotado para o ingresso unico.';
  end if;
  v_remaining:=greatest(v_batch.max_confirmed_registrations-v_confirmed,0);

  if v_gender in('feminino','female','f') then v_base:=round(v_batch.female_price,2);
  elsif v_gender in('masculino','male','m') then v_base:=round(v_batch.male_price,2);
  else raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;
  v_final:=v_base;

  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    select * into v_coupon from public.validate_coupon(trim(p_coupon_code),v_event_id,v_base) limit 1;
    v_discount:=round(coalesce(v_coupon.discount_amount,0),2);
    v_final:=round(coalesce(v_coupon.final_amount,v_base),2);
    return query select v_batch.id,v_batch.name,v_batch.sequence_number,v_base,v_discount,v_final,v_remaining,
      coalesce(v_coupon.message,'Cupom aplicado.'),coalesce(v_coupon.coupon_type,''),coalesce(v_coupon.discount_percent,0);
    return;
  end if;
  return query select v_batch.id,v_batch.name,v_batch.sequence_number,v_base,0::numeric,v_final,v_remaining,
    null::text,null::text,0::numeric;
end; $$;

-- Leitura para a tela administrativa: estado atual do preco do ingresso unico
-- deste evento, sem expor nomes de RPC nem a coluna flat_price_confirmed ao
-- usuario final (isso e feito pela UI, este RPC so devolve os dados).
create or replace function public.get_event_single_ticket_price_status(p_event_id uuid)
returns table(
  active_category_count integer,
  batch_id uuid,
  male_price numeric,
  female_price numeric,
  price_confirmed boolean,
  registration_enabled boolean
) language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_event public.events%rowtype;
  v_active_category_count integer; v_batch public.registration_batches%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  select count(*) into v_active_category_count from public.ticket_categories where event_id=p_event_id and is_active=true;
  select * into v_batch from public.registration_batches where event_id=p_event_id and is_active=true order by sequence_number desc limit 1;
  return query select v_active_category_count,v_batch.id,v_batch.male_price,v_batch.female_price,
    coalesce(v_batch.flat_price_confirmed,false),coalesce(v_event.registration_enabled,false);
end; $$;

revoke all on function public.get_event_single_ticket_price_status(uuid) from public,anon;
grant execute on function public.get_event_single_ticket_price_status(uuid) to authenticated,service_role;

-- Substituida por set_event_single_ticket_price (abaixo), que tambem cria o
-- lote quando ele ainda nao existe. Um unico caminho canonico evita que a
-- administracao precise escolher entre duas RPCs para a mesma decisao.
drop function if exists public.confirm_registration_batch_flat_price(uuid,uuid,numeric,numeric,text);

-- Unico caminho de escrita para o preco do ingresso unico: cria o lote quando o
-- evento ainda nao tem nenhum (caso comum de evento realmente sem categoria) ou
-- atualiza+confirma o lote ativo existente (caso de evento que tinha categorias
-- e foi esvaziado de proposito). Sempre exige 0 categorias ativas.
create or replace function public.set_event_single_ticket_price(
  p_event_id uuid,p_male_price numeric,p_female_price numeric,p_reason text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_active_category_count integer;
  v_batch public.registration_batches%rowtype; v_batch_id uuid; v_created boolean:=false;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao para configurar o preco do evento.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;

  select count(*) into v_active_category_count from public.ticket_categories where event_id=p_event_id and is_active=true;
  if v_active_category_count>0 then
    raise exception 'Este evento usa categorias ativas; configure o preco por categoria em vez do ingresso unico.';
  end if;

  if p_male_price is null or p_male_price<0 or p_female_price is null or p_female_price<0 then
    raise exception 'Precos do ingresso unico devem ser maiores ou iguais a zero.';
  end if;

  select * into v_batch from public.registration_batches where event_id=p_event_id and is_active=true
    order by sequence_number desc limit 1 for update;

  if found then
    update public.registration_batches set male_price=round(p_male_price,2),female_price=round(p_female_price,2),
      flat_price_confirmed=true,updated_at=now() where id=v_batch.id;
    v_batch_id:=v_batch.id;
  else
    v_batch_id:=public.create_registration_batch(p_event_id,'Ingresso unico',1,round(p_male_price,2),round(p_female_price,2),
      999999,null,null,true,true);
    v_created:=true;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('registration_batch_flat_price_confirmed','registration_batches',v_batch_id,p_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'male_price',round(p_male_price,2),'female_price',round(p_female_price,2),
    'reason',nullif(trim(coalesce(p_reason,'')),''),'source','set_event_single_ticket_price','created_batch',v_created));

  return v_batch_id;
end; $$;

revoke all on function public.set_event_single_ticket_price(uuid,numeric,numeric,text) from public,anon;
grant execute on function public.set_event_single_ticket_price(uuid,numeric,numeric,text) to authenticated,service_role;

-- Uma confirmacao de preco de ingresso unico so vale para o periodo em que o
-- evento realmente nao tinha categoria ativa. No momento em que qualquer
-- categoria do evento passa a existir/ficar ativa (por create_ticket_category,
-- update_ticket_category ou qualquer outra escrita direta), a confirmacao fica
-- obsoleta: se as categorias forem removidas/desativadas depois, o operador
-- precisa confirmar o preco do ingresso unico de novo, mesmo que o numero
-- antigo continue igual.
create or replace function public.invalidate_single_ticket_price_on_category_activation()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(new.is_active,false) then
    update public.registration_batches set flat_price_confirmed=false,updated_at=now()
    where event_id=new.event_id and flat_price_confirmed=true;
  end if;
  return new;
end; $$;

drop trigger if exists trg_invalidate_single_ticket_price on public.ticket_categories;
create trigger trg_invalidate_single_ticket_price
  after insert or update of is_active on public.ticket_categories
  for each row execute function public.invalidate_single_ticket_price_on_category_activation();

commit;
