-- Ingresso unico unissex: um preco e um limite por lote, sem Masculino/Feminino
-- obrigatorios. Nao cria arquitetura paralela -- reusa registration_batches.
--
-- AUDITORIA (causa raiz):
--   O modo "Ingresso unico (sem categoria)" ja e activeCategoryCount = 0.
--   A separacao Masculino/Feminino NAO vem de ticket_categories. Vem de
--   create_single_ticket_batch (20260865000000), que SEMPRE grava
--   male_max_confirmed_registrations + female_max_confirmed_registrations
--   (NOT NULL nos dois = modo gender_split). A UI administrativa sempre
--   renderiza dois cards. O checkout exige genero mesmo com precos iguais
--   porque genderIndependentPriceAvailable so olha categorias.
--
-- MODELO CANONICO DE CAPACIDADE (ja existia, so nao era o default de escrita):
--   male_max IS NULL AND female_max IS NULL = capacidade pooled unissex em
--   max_confirmed_registrations. O resolver ja trata esse caso. Lotes
--   gender_split existentes (limites por genero preenchidos) continuam
--   intactos -- nenhuma conversao silenciosa.
--
-- Esta migration:
--   1) passa a resolver lote unissex sem exigir genero;
--   2) preview de preco unissex nao usa genero da pessoa;
--   3) RPCs novas de criar/editar/encerrar lote unissex;
--   4) impede que update_single_ticket_batch converta lote unissex em split;
--   5) RPC publica de oferta + RPC admin do modelo de venda (0 categorias
--      ativas = ingresso unico; categorias ativas = por categoria).
begin;

comment on column public.registration_batches.male_max_confirmed_registrations is
  'Limite de confirmados so para pricing_gender=male neste lote. NULL junto com female_max = ingresso unico unissex (capacidade pooled em max_confirmed_registrations). NOT NULL junto com female_max = modelo legado/opcional com split por genero. Nunca um sem o outro.';
comment on column public.registration_batches.female_max_confirmed_registrations is
  'Limite de confirmados so para pricing_gender=female neste lote. Ver comentario de male_max_confirmed_registrations.';


-- ---------------------------------------------------------------------------
-- Resolver: genero vazio so e aceito para lotes pooled (unissex).
-- Genero valido preserva o comportamento anterior (split ou pooled).
-- ---------------------------------------------------------------------------
create or replace function public.resolve_single_ticket_batch_for_gender(p_event_id uuid, p_gender text)
returns public.registration_batches
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gender text := case
    when lower(trim(coalesce(p_gender, ''))) in ('feminino', 'female', 'f') then 'female'
    when lower(trim(coalesce(p_gender, ''))) in ('masculino', 'male', 'm') then 'male'
    else null
  end;
  v_batch public.registration_batches%rowtype;
  v_confirmed integer;
  v_max integer;
  v_gender_split boolean;
begin
  if v_gender is null then
    for v_batch in
      select rb.*
      from public.registration_batches rb
      where rb.event_id = p_event_id
        and rb.is_active
        and coalesce(rb.flat_price_confirmed, false)
        and not exists (select 1 from public.registration_batch_prices rbp where rbp.batch_id = rb.id)
        and (rb.starts_at is null or now() >= rb.starts_at)
        and (rb.ends_at is null or now() <= rb.ends_at)
        and rb.male_max_confirmed_registrations is null
        and not rb.male_closed
        and not rb.female_closed
      order by rb.male_price asc, rb.sequence_number asc
    loop
      select count(*)::integer into v_confirmed
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.event_id = p_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
        and oi.status = 'confirmed' and o.status = 'confirmed';
      v_max := v_batch.max_confirmed_registrations;
      if v_confirmed < v_max then
        return v_batch;
      end if;
    end loop;
    return null;
  end if;

  for v_batch in
    select rb.*
    from public.registration_batches rb
    where rb.event_id = p_event_id
      and rb.is_active
      and coalesce(rb.flat_price_confirmed, false)
      and not exists (select 1 from public.registration_batch_prices rbp where rbp.batch_id = rb.id)
      and (rb.starts_at is null or now() >= rb.starts_at)
      and (rb.ends_at is null or now() <= rb.ends_at)
      and not (case when v_gender = 'male' then rb.male_closed else rb.female_closed end)
    order by (case when v_gender = 'male' then rb.male_price else rb.female_price end) asc, rb.sequence_number asc
  loop
    v_gender_split := v_batch.male_max_confirmed_registrations is not null;

    if v_gender_split then
      select count(*)::integer into v_confirmed
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.event_id = p_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
        and oi.pricing_gender = v_gender and oi.status = 'confirmed' and o.status = 'confirmed';
      v_max := case when v_gender = 'male' then v_batch.male_max_confirmed_registrations else v_batch.female_max_confirmed_registrations end;
    else
      select count(*)::integer into v_confirmed
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.event_id = p_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
        and oi.status = 'confirmed' and o.status = 'confirmed';
      v_max := v_batch.max_confirmed_registrations;
    end if;

    if v_confirmed < v_max then
      return v_batch;
    end if;
  end loop;

  return null;
end; $$;

revoke all on function public.resolve_single_ticket_batch_for_gender(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_single_ticket_batch_for_gender(uuid, text) to service_role;


create or replace function public.get_registration_pricing_preview(
  p_gender text, p_coupon_code text default null, p_event_id uuid default null, p_ticket_category_id uuid default null
) returns table(batch_id uuid, batch_name text, sequence_number integer, base_amount numeric, discount_amount numeric,
  final_amount numeric, remaining_slots integer, coupon_message text, coupon_type text, discount_percent numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event_id uuid := p_event_id; v_batch public.registration_batches%rowtype; v_coupon record;
  v_gender text := lower(trim(coalesce(p_gender, ''))); v_base numeric; v_discount numeric := 0; v_final numeric;
  v_eligible_categories integer := 0; v_active_categories integer := 0; v_remaining integer; v_max integer; v_confirmed integer;
  v_unisex boolean;
begin
  if v_event_id is null then
    select e.id into v_event_id from public.events e where e.is_active order by e.created_at desc limit 1;
  end if;
  if v_event_id is null then raise exception 'Nenhum evento ativo encontrado.'; end if;

  if p_ticket_category_id is not null then
    return query select * from public.get_registration_pricing_preview_categorized_legacy(
      p_gender, p_coupon_code, v_event_id, p_ticket_category_id);
    return;
  end if;

  select count(*) into v_active_categories from public.ticket_categories tc where tc.event_id = v_event_id and tc.is_active = true;

  select count(*) into v_eligible_categories from public.get_event_ticket_categories(v_event_id) tc
  where tc.is_active and (tc.available_slots is null or tc.available_slots > 0) and tc.current_batch_id is not null;
  if v_eligible_categories > 0 then
    raise exception using errcode = 'P0001', message = 'TICKET_CATEGORY_REQUIRED',
      detail = jsonb_build_object('code', 'TICKET_CATEGORY_REQUIRED', 'message', 'Selecione uma categoria de ingresso.')::text;
  end if;

  if v_active_categories > 0 then
    raise exception using errcode = 'P0001', message = 'TICKET_CATEGORY_UNAVAILABLE',
      detail = jsonb_build_object('code', 'TICKET_CATEGORY_UNAVAILABLE',
        'message', 'Nenhuma categoria de ingresso esta disponivel neste momento.')::text;
  end if;

  select * into v_batch from public.resolve_single_ticket_batch_for_gender(v_event_id, p_gender);
  if not found or v_batch.id is null then
    raise exception 'Lote esgotado para o ingresso unico.';
  end if;

  v_unisex := v_batch.male_max_confirmed_registrations is null;
  if v_unisex then
    v_base := round(v_batch.male_price, 2);
    select count(*)::integer into v_confirmed from public.order_items oi join public.orders o on o.id = oi.order_id
      where oi.event_id = v_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
        and oi.status = 'confirmed' and o.status = 'confirmed';
    v_max := v_batch.max_confirmed_registrations;
  elsif v_gender in ('feminino', 'female', 'f') then
    v_base := round(v_batch.female_price, 2);
    select count(*)::integer into v_confirmed from public.order_items oi join public.orders o on o.id = oi.order_id
      where oi.event_id = v_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
        and oi.pricing_gender = 'female' and oi.status = 'confirmed' and o.status = 'confirmed';
    v_max := v_batch.female_max_confirmed_registrations;
  elsif v_gender in ('masculino', 'male', 'm') then
    v_base := round(v_batch.male_price, 2);
    select count(*)::integer into v_confirmed from public.order_items oi join public.orders o on o.id = oi.order_id
      where oi.event_id = v_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
        and oi.pricing_gender = 'male' and oi.status = 'confirmed' and o.status = 'confirmed';
    v_max := v_batch.male_max_confirmed_registrations;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;
  v_remaining := greatest(v_max - v_confirmed, 0);
  v_final := v_base;

  if nullif(trim(coalesce(p_coupon_code, '')), '') is not null then
    select * into v_coupon from public.validate_coupon(trim(p_coupon_code), v_event_id, v_base) limit 1;
    v_discount := round(coalesce(v_coupon.discount_amount, 0), 2);
    v_final := round(coalesce(v_coupon.final_amount, v_base), 2);
    return query select v_batch.id, v_batch.name, v_batch.sequence_number, v_base, v_discount, v_final, v_remaining,
      coalesce(v_coupon.message, 'Cupom aplicado.'), coalesce(v_coupon.coupon_type, ''), coalesce(v_coupon.discount_percent, 0);
    return;
  end if;
  return query select v_batch.id, v_batch.name, v_batch.sequence_number, v_base, 0::numeric, v_final, v_remaining,
    null::text, null::text, 0::numeric;
end; $$;


-- Impede que a RPC legado de split converta um lote unissex em gender_split.
create or replace function public.update_single_ticket_batch(
  p_batch_id uuid, p_name text, p_male_price numeric, p_female_price numeric,
  p_male_max integer, p_female_max integer, p_starts_at timestamptz default null, p_ends_at timestamptz default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_batch public.registration_batches%rowtype; v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;
  select * into v_batch from public.registration_batches where id = p_batch_id for update;
  if not found then raise exception 'Lote nao encontrado.'; end if;
  if exists (select 1 from public.registration_batch_prices rbp where rbp.batch_id = p_batch_id) then
    raise exception 'Este lote pertence ao fluxo com categoria; edite pela tela de lotes por categoria.';
  end if;
  if v_batch.male_max_confirmed_registrations is null then
    raise exception 'Este lote e ingresso unico unissex; edite preco e limite unicos.';
  end if;
  select * into v_event from public.events where id = v_batch.event_id;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  if p_male_price is null or p_male_price < 0 or p_female_price is null or p_female_price < 0 then
    raise exception 'Precos do ingresso unico devem ser maiores ou iguais a zero.';
  end if;
  if p_male_max is null or p_male_max <= 0 or p_female_max is null or p_female_max <= 0 then
    raise exception 'Informe limite de vagas masculino e feminino, maiores que zero.';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nome do lote obrigatorio.'; end if;

  update public.registration_batches
  set name = trim(p_name), male_price = round(p_male_price, 2), female_price = round(p_female_price, 2),
      max_confirmed_registrations = p_male_max + p_female_max,
      male_max_confirmed_registrations = p_male_max, female_max_confirmed_registrations = p_female_max,
      starts_at = p_starts_at, ends_at = p_ends_at, flat_price_confirmed = true, updated_at = now()
  where id = p_batch_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('single_ticket_batch_updated', 'registration_batches', p_batch_id, v_batch.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'name', trim(p_name), 'male_price', round(p_male_price, 2), 'female_price', round(p_female_price, 2),
    'male_max', p_male_max, 'female_max', p_female_max
  ));

  return true;
end; $$;


create or replace function public.create_single_ticket_unisex_batch(
  p_event_id uuid, p_name text, p_sequence_number integer,
  p_price numeric, p_max integer,
  p_starts_at timestamptz default null, p_ends_at timestamptz default null,
  p_closed boolean default false
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_event public.events%rowtype; v_active_category_count integer; v_batch_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  select count(*) into v_active_category_count from public.ticket_categories where event_id = p_event_id and is_active = true;
  if v_active_category_count > 0 then
    raise exception 'Este evento usa categorias ativas; configure lotes por categoria em vez de ingresso unico.';
  end if;

  if p_price is null or p_price < 0 then
    raise exception 'Preco do ingresso unico deve ser maior ou igual a zero.';
  end if;
  if p_max is null or p_max <= 0 then
    raise exception 'Informe o limite de vagas, maior que zero.';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nome do lote obrigatorio.'; end if;
  if p_sequence_number is null or p_sequence_number <= 0 then raise exception 'Ordem do lote invalida.'; end if;

  insert into public.registration_batches (
    event_id, name, sequence_number, male_price, female_price, max_confirmed_registrations,
    male_max_confirmed_registrations, female_max_confirmed_registrations,
    starts_at, ends_at, is_active, flat_price_confirmed, male_closed, female_closed
  ) values (
    p_event_id, trim(p_name), p_sequence_number, round(p_price, 2), round(p_price, 2), p_max,
    null, null, p_starts_at, p_ends_at, true, true, coalesce(p_closed, false), coalesce(p_closed, false)
  ) returning id into v_batch_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('single_ticket_unisex_batch_created', 'registration_batches', v_batch_id, p_event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'name', trim(p_name), 'sequence_number', p_sequence_number,
    'price', round(p_price, 2), 'max', p_max, 'closed', coalesce(p_closed, false)
  ));

  return v_batch_id;
end; $$;

revoke all on function public.create_single_ticket_unisex_batch(uuid, text, integer, numeric, integer, timestamptz, timestamptz, boolean) from public, anon;
grant execute on function public.create_single_ticket_unisex_batch(uuid, text, integer, numeric, integer, timestamptz, timestamptz, boolean) to authenticated, service_role;


create or replace function public.update_single_ticket_unisex_batch(
  p_batch_id uuid, p_name text, p_price numeric, p_max integer,
  p_starts_at timestamptz default null, p_ends_at timestamptz default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_batch public.registration_batches%rowtype; v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;
  select * into v_batch from public.registration_batches where id = p_batch_id for update;
  if not found then raise exception 'Lote nao encontrado.'; end if;
  if exists (select 1 from public.registration_batch_prices rbp where rbp.batch_id = p_batch_id) then
    raise exception 'Este lote pertence ao fluxo com categoria; edite pela tela de lotes por categoria.';
  end if;
  if v_batch.male_max_confirmed_registrations is not null then
    raise exception 'Este lote usa limite por genero; edite masculino e feminino.';
  end if;
  select * into v_event from public.events where id = v_batch.event_id;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  if p_price is null or p_price < 0 then
    raise exception 'Preco do ingresso unico deve ser maior ou igual a zero.';
  end if;
  if p_max is null or p_max <= 0 then
    raise exception 'Informe o limite de vagas, maior que zero.';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nome do lote obrigatorio.'; end if;

  update public.registration_batches
  set name = trim(p_name), male_price = round(p_price, 2), female_price = round(p_price, 2),
      max_confirmed_registrations = p_max,
      male_max_confirmed_registrations = null, female_max_confirmed_registrations = null,
      starts_at = p_starts_at, ends_at = p_ends_at, flat_price_confirmed = true, updated_at = now()
  where id = p_batch_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('single_ticket_unisex_batch_updated', 'registration_batches', p_batch_id, v_batch.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'name', trim(p_name), 'price', round(p_price, 2), 'max', p_max
  ));

  return true;
end; $$;

revoke all on function public.update_single_ticket_unisex_batch(uuid, text, numeric, integer, timestamptz, timestamptz) from public, anon;
grant execute on function public.update_single_ticket_unisex_batch(uuid, text, numeric, integer, timestamptz, timestamptz) to authenticated, service_role;


create or replace function public.set_single_ticket_batch_closed(
  p_batch_id uuid, p_closed boolean
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_batch public.registration_batches%rowtype; v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select * into v_batch from public.registration_batches where id = p_batch_id for update;
  if not found then raise exception 'Lote nao encontrado.'; end if;
  if exists (select 1 from public.registration_batch_prices rbp where rbp.batch_id = p_batch_id) then
    raise exception 'Este lote pertence ao fluxo com categoria.';
  end if;
  select * into v_event from public.events where id = v_batch.event_id;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  update public.registration_batches
  set male_closed = coalesce(p_closed, false), female_closed = coalesce(p_closed, false), updated_at = now()
  where id = p_batch_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    case when coalesce(p_closed, false) then 'single_ticket_batch_closed' else 'single_ticket_batch_reopened' end,
    'registration_batches', p_batch_id, v_batch.event_id,
    jsonb_build_object('actor_user_id', v_actor, 'closed', coalesce(p_closed, false))
  );

  return true;
end; $$;

revoke all on function public.set_single_ticket_batch_closed(uuid, boolean) from public, anon;
grant execute on function public.set_single_ticket_batch_closed(uuid, boolean) to authenticated, service_role;


-- Oferta publica do lote vigente de ingresso unico. Checkout autenticado.
create or replace function public.get_public_single_ticket_offer(p_event_id uuid)
returns table(
  is_unisex boolean, gender_split boolean,
  batch_id uuid, batch_name text, sequence_number integer,
  price numeric, male_price numeric, female_price numeric,
  remaining integer, max_slots integer
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_active_categories integer := 0;
  v_batch public.registration_batches%rowtype;
  v_confirmed integer := 0;
  v_unisex boolean;
begin
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;

  select count(*) into v_active_categories
  from public.ticket_categories tc where tc.event_id = p_event_id and tc.is_active = true;
  if v_active_categories > 0 then
    return;
  end if;

  select * into v_batch from public.resolve_single_ticket_batch_for_gender(p_event_id, null);
  if v_batch.id is null then
    select * into v_batch from public.resolve_single_ticket_batch_for_gender(p_event_id, 'male');
  end if;
  if v_batch.id is null then
    return;
  end if;

  v_unisex := v_batch.male_max_confirmed_registrations is null;
  if v_unisex then
    select count(*)::integer into v_confirmed
    from public.order_items oi join public.orders o on o.id = oi.order_id
    where oi.event_id = p_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
      and oi.status = 'confirmed' and o.status = 'confirmed';
    return query select
      true, false, v_batch.id, v_batch.name, v_batch.sequence_number,
      v_batch.male_price, v_batch.male_price, v_batch.female_price,
      greatest(v_batch.max_confirmed_registrations - v_confirmed, 0),
      v_batch.max_confirmed_registrations;
  else
    return query select
      false, true, v_batch.id, v_batch.name, v_batch.sequence_number,
      case when v_batch.male_price = v_batch.female_price then v_batch.male_price else null end,
      v_batch.male_price, v_batch.female_price,
      null::integer, null::integer;
  end if;
end; $$;

revoke all on function public.get_public_single_ticket_offer(uuid) from public, anon;
grant execute on function public.get_public_single_ticket_offer(uuid) to authenticated, service_role;


-- Controle visivel do modelo: reusa 0 categorias ativas vs categorias.
-- 'single' desativa todas as categorias (lotes de categoria ficam dormentes).
-- 'categories' nao inventa Masculino/Feminino -- o admin cria as categorias.
create or replace function public.set_event_ticket_sale_model(p_event_id uuid, p_model text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_event public.events%rowtype; v_model text := lower(trim(coalesce(p_model, '')));
  v_deactivated integer := 0;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;
  if v_model not in ('single', 'categories') then
    raise exception 'Modelo de ingresso invalido.';
  end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  if v_model = 'single' then
    update public.ticket_categories
    set is_active = false, updated_at = now()
    where event_id = p_event_id and is_active = true;
    get diagnostics v_deactivated = row_count;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('event_ticket_sale_model_set', 'events', p_event_id, p_event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'model', v_model, 'deactivated_categories', v_deactivated
  ));

  return true;
end; $$;

revoke all on function public.set_event_ticket_sale_model(uuid, text) from public, anon;
grant execute on function public.set_event_ticket_sale_model(uuid, text) to authenticated, service_role;

commit;
