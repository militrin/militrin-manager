-- Corrige a causa comercial do checkout adaptativo (evento sem categorias)
-- retornando preco final zero sem cupom, cortesia ou lote resolvido.
--
-- Causa raiz: registration_batches.male_price/female_price nunca foi um preco
-- deliberado de "ingresso unico". Essas colunas so existem como espelho legado
-- do primeiro item habilitado enviado a create/update_registration_batch_with_prices
-- (RPCs que exigem ao menos uma ticket_categories ativa) ou como copia bruta feita
-- por duplicate_event_configuration quando categorias nao sao duplicadas junto do
-- lote. Em nenhum dos dois casos um operador confirmou deliberadamente esse valor
-- como o preco do ingresso unico; a migration 20260815006000 passou a ler esse
-- espelho como se fosse autoritativo, permitindo pedidos com final_amount=0 sem
-- cupom e sem cortesia administrativa.
begin;

alter table public.registration_batches
  add column if not exists flat_price_confirmed boolean not null default false;

comment on column public.registration_batches.flat_price_confirmed is
  'Confirma que male_price/female_price foram deliberadamente definidos como o preco do ingresso unico (evento sem categorias). Nunca inferido a partir de copia ou de precos por categoria; setado apenas por quem cria/edita o lote com essa intencao explicita.';

-- Assinatura muda (novo parametro no fim): precisa dropar a antiga para nao
-- deixar dois overloads ambiguos, igual ao problema corrigido em admin_transfer_ticket_holder.
drop function if exists public.create_registration_batch(
  uuid,text,integer,numeric,numeric,integer,timestamptz,timestamptz,boolean
);

create or replace function public.create_registration_batch(
  p_event_id uuid,p_name text,p_sequence_number integer,p_male_price numeric,p_female_price numeric,
  p_max_confirmed_registrations integer,p_starts_at timestamptz,p_ends_at timestamptz,p_is_active boolean default false,
  p_flat_price_confirmed boolean default false
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_id uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do lote obrigatorio.';
  end if;

  if p_sequence_number is null then
    raise exception 'Numero de sequencia obrigatorio.';
  end if;

  if p_male_price is null or p_male_price < 0 or p_female_price is null or p_female_price < 0 then
    raise exception 'Precos do lote devem ser maiores ou iguais a zero.';
  end if;

  if p_max_confirmed_registrations is null or p_max_confirmed_registrations <= 0 then
    raise exception 'Limite do lote deve ser maior que zero.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_starts_at > p_ends_at then
    raise exception 'Janela de datas invalida para o lote.';
  end if;

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id;
  end if;

  insert into public.registration_batches (
    event_id,
    name,
    sequence_number,
    male_price,
    female_price,
    max_confirmed_registrations,
    starts_at,
    ends_at,
    is_active,
    flat_price_confirmed
  ) values (
    p_event_id,
    trim(p_name),
    p_sequence_number,
    round(p_male_price, 2),
    round(p_female_price, 2),
    p_max_confirmed_registrations,
    p_starts_at,
    p_ends_at,
    coalesce(p_is_active, false),
    coalesce(p_flat_price_confirmed, false)
  ) returning id into v_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_created',
    'registration_batches',
    v_id,
    jsonb_build_object(
      'name', trim(p_name),
      'sequence_number', p_sequence_number,
      'male_price', round(p_male_price, 2),
      'female_price', round(p_female_price, 2),
      'max_confirmed_registrations', p_max_confirmed_registrations,
      'is_active', coalesce(p_is_active, false),
      'flat_price_confirmed', coalesce(p_flat_price_confirmed, false)
    ),
    p_event_id
  );

  return v_id;
end;
$$;

revoke all on function public.create_registration_batch(
  uuid,text,integer,numeric,numeric,integer,timestamptz,timestamptz,boolean,boolean
) from public;
grant execute on function public.create_registration_batch(
  uuid,text,integer,numeric,numeric,integer,timestamptz,timestamptz,boolean,boolean
) to service_role,anon,authenticated;

-- Recriada apenas para deixar explicito que uma copia de lote sem categorias
-- copiadas nunca herda uma confirmacao de preco: o novo evento comeca com
-- flat_price_confirmed=false (default da coluna) e precisa de revisao humana
-- antes de vender o ingresso unico.
create or replace function public.duplicate_event_configuration(
  p_source_event_id uuid,p_target_name text,p_target_slug text,p_target_year integer default null,
  p_copy_categories boolean default true,p_copy_kit_items boolean default true,p_copy_benefits boolean default true,
  p_copy_batches boolean default true,p_copy_batch_prices boolean default true,p_copy_inventory_structure boolean default true,
  p_copy_coupons boolean default false
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_target_event_id uuid;
  v_item record;
  v_new_item_id uuid;
  v_new_batch_id uuid;
  v_batch record;
  v_open_bar_id uuid;
  v_target_category_id uuid;
begin
  if p_source_event_id is null then
    raise exception 'Evento de origem obrigatorio.';
  end if;

  v_target_event_id := public.create_event(
    p_target_name,
    p_target_slug,
    p_target_year,
    null,
    null,
    null,
    null,
    null,
    null,
    false,
    false,
    true
  );

  if p_copy_categories then
    insert into public.ticket_categories (
      event_id,
      name,
      slug,
      description,
      capacity,
      is_active,
      sort_order
    )
    select
      v_target_event_id,
      tc.name,
      tc.slug,
      tc.description,
      tc.capacity,
      tc.is_active,
      tc.sort_order
    from public.ticket_categories tc
    where tc.event_id = p_source_event_id
    on conflict (event_id, slug) do nothing;

    if p_copy_benefits then
      insert into public.ticket_category_benefits (
        ticket_category_id,
        name,
        description,
        sort_order
      )
      select
        tc_target.id,
        b.name,
        b.description,
        b.sort_order
      from public.ticket_category_benefits b
      join public.ticket_categories tc_source
        on tc_source.id = b.ticket_category_id
      join public.ticket_categories tc_target
        on tc_target.event_id = v_target_event_id
       and tc_target.slug = tc_source.slug
      where tc_source.event_id = p_source_event_id;
    end if;
  end if;

  if p_copy_kit_items then
    for v_item in
      select *
      from public.event_kit_items
      where event_id = p_source_event_id
      order by sort_order asc, created_at asc
    loop
      v_new_item_id := public.upsert_event_kit_item(
        null,
        v_target_event_id,
        v_item.name,
        v_item.slug,
        v_item.description,
        v_item.item_type,
        v_item.quantity_per_participant,
        v_item.requires_variant,
        v_item.is_required,
        v_item.is_active,
        v_item.sort_order
      );

      insert into public.event_kit_item_variants (
        kit_item_id,
        name,
        value,
        sort_order,
        is_active
      )
      select
        v_new_item_id,
        v.name,
        v.value,
        v.sort_order,
        v.is_active
      from public.event_kit_item_variants v
      where v.kit_item_id = v_item.id;
    end loop;
  end if;

  if p_copy_batches then
    for v_batch in
      select *
      from public.registration_batches
      where event_id = p_source_event_id
      order by sequence_number asc
    loop
      v_new_batch_id := public.create_registration_batch(
        v_target_event_id,
        v_batch.name,
        v_batch.sequence_number,
        v_batch.male_price,
        v_batch.female_price,
        v_batch.max_confirmed_registrations,
        v_batch.starts_at,
        v_batch.ends_at,
        false,
        false
      );

      if p_copy_batch_prices then
        insert into public.registration_batch_prices (
          batch_id,
          ticket_category_id,
          male_price,
          female_price
        )
        select
          v_new_batch_id,
          tc_target.id,
          rbp.male_price,
          rbp.female_price
        from public.registration_batch_prices rbp
        join public.ticket_categories tc_source
          on tc_source.id = rbp.ticket_category_id
        join public.ticket_categories tc_target
          on tc_target.event_id = v_target_event_id
         and tc_target.slug = tc_source.slug
        where rbp.batch_id = v_batch.id
        on conflict (batch_id, ticket_category_id)
        do update set
          male_price = excluded.male_price,
          female_price = excluded.female_price,
          updated_at = now();
      end if;
    end loop;
  end if;

  if p_copy_inventory_structure then
    insert into public.shirt_inventory (
      event_id,
      shirt_type,
      shirt_size,
      total_quantity,
      reserved_quantity,
      delivered_quantity
    )
    select
      v_target_event_id,
      si.shirt_type,
      si.shirt_size,
      0,
      0,
      0
    from public.shirt_inventory si
    where si.event_id = p_source_event_id
    on conflict (event_id, shirt_type, shirt_size)
    do nothing;
  end if;

  if p_copy_coupons then
    insert into public.coupons (
      event_id,
      code,
      notes,
      coupon_type,
      discount_percent,
      max_uses,
      used_count,
      valid_from,
      valid_until,
      is_active
    )
    select
      v_target_event_id,
      c.code,
      c.notes,
      c.coupon_type,
      c.discount_percent,
      c.max_uses,
      0,
      c.valid_from,
      c.valid_until,
      false
    from public.coupons c
    where c.event_id = p_source_event_id
    on conflict (event_id, code)
    do nothing;
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_configuration_duplicated',
    'events',
    v_target_event_id,
    v_target_event_id,
    jsonb_build_object(
      'source_event_id', p_source_event_id,
      'copy_categories', p_copy_categories,
      'copy_kit_items', p_copy_kit_items,
      'copy_benefits', p_copy_benefits,
      'copy_batches', p_copy_batches,
      'copy_batch_prices', p_copy_batch_prices,
      'copy_inventory_structure', p_copy_inventory_structure,
      'copy_coupons', p_copy_coupons
    )
  );

  return v_target_event_id;
end;
$$;

-- Distingue determinsticamente as tres situacoes possiveis quando nenhuma
-- categoria foi selecionada: (1) o evento tem categorias elegiveis e a
-- selecao e obrigatoria; (2) o evento tem categorias mas nenhuma esta
-- disponivel agora (nao e "ingresso unico", e indisponibilidade real); (3) o
-- evento nunca teve categoria e realmente opera como ingresso unico -- caso em
-- que o preco do lote so pode ser usado se foi explicitamente confirmado.
create or replace function public.get_registration_pricing_preview(
  p_gender text,p_coupon_code text default null,p_event_id uuid default null,p_ticket_category_id uuid default null
) returns table(batch_id uuid,batch_name text,sequence_number integer,base_amount numeric,discount_amount numeric,
  final_amount numeric,remaining_slots integer,coupon_message text,coupon_type text,discount_percent numeric)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event_id uuid:=p_event_id; v_batch public.registration_batches%rowtype; v_coupon record;
  v_gender text:=lower(trim(coalesce(p_gender,''))); v_base numeric; v_discount numeric:=0; v_final numeric;
  v_confirmed integer:=0; v_eligible_categories integer:=0; v_total_categories integer:=0; v_remaining integer;
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

  select count(*) into v_total_categories from public.ticket_categories tc where tc.event_id=v_event_id;

  select count(*) into v_eligible_categories from public.get_event_ticket_categories(v_event_id) tc
  where tc.is_active and (tc.available_slots is null or tc.available_slots>0) and tc.current_batch_id is not null;
  if v_eligible_categories>0 then
    raise exception using errcode='P0001',message='TICKET_CATEGORY_REQUIRED',
      detail=jsonb_build_object('code','TICKET_CATEGORY_REQUIRED','message','Selecione uma categoria de ingresso.')::text;
  end if;

  if v_total_categories>0 then
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

-- Unico caminho para confirmar deliberadamente o preco de um lote de evento
-- sem categorias. Sem esta chamada (ou equivalente futuro na UI), o checkout
-- adaptativo bloqueia a venda em vez de usar um preco nao confirmado.
create or replace function public.confirm_registration_batch_flat_price(
  p_batch_id uuid,p_event_id uuid,p_male_price numeric,p_female_price numeric,p_reason text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_event public.events%rowtype;
  v_category_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao para configurar lotes.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  perform 1 from public.registration_batches where id=p_batch_id and event_id=p_event_id for update;
  if not found then raise exception 'Lote nao encontrado para o evento.'; end if;
  select count(*) into v_category_count from public.ticket_categories where event_id=p_event_id;
  if v_category_count>0 then
    raise exception 'Este evento usa categorias; configure o preco por categoria no lote em vez de um preco unico.';
  end if;
  if p_male_price is null or p_male_price<0 or p_female_price is null or p_female_price<0 then
    raise exception 'Precos do lote devem ser maiores ou iguais a zero.';
  end if;
  update public.registration_batches set male_price=round(p_male_price,2),female_price=round(p_female_price,2),
    flat_price_confirmed=true,updated_at=now() where id=p_batch_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('registration_batch_flat_price_confirmed','registration_batches',p_batch_id,p_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'male_price',round(p_male_price,2),'female_price',round(p_female_price,2),
    'reason',nullif(trim(coalesce(p_reason,'')),'')));
  return true;
end; $$;

revoke all on function public.confirm_registration_batch_flat_price(uuid,uuid,numeric,numeric,text) from public,anon;
grant execute on function public.confirm_registration_batch_flat_price(uuid,uuid,numeric,numeric,text) to authenticated,service_role;

commit;
