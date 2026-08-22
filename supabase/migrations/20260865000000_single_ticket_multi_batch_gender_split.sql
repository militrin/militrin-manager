-- Substitui o modelo de "preco fixo unico" do Ingresso unico (sem categoria)
-- por multiplos lotes reais, com virada independente por genero.
--
-- AUDITORIA PREVIA (nao criar arquitetura paralela):
--   - registration_batches ja e a tabela usada tanto pelo fluxo COM categoria
--     (nesse caso male_price/female_price/max_confirmed_registrations da
--     propria linha ficam "orfaos", o preco real vem de
--     registration_batch_prices por categoria) quanto pelo fluxo SEM
--     categoria (nesse caso male_price/female_price/max_confirmed_registrations
--     da propria linha SAO o preco real -- e o caso que esta migration
--     estende). Um lote "sem categoria" e identificado pela AUSENCIA de
--     qualquer linha em registration_batch_prices apontando pra ele --
--     mesma premissa ja usada implicitamente pelo ramo sem-categoria de
--     get_registration_pricing_preview antes desta migration.
--   - O fluxo COM categoria (registration_batch_prices,
--     get_registration_pricing_preview_categorized_legacy,
--     create_registration_batch_with_prices, BatchesManager em
--     src/app/lotes/) NAO E TOCADO por esta migration -- zero risco de
--     regressao ali.
--   - create_registration_batch/create_registration_batch_with_prices (que
--     desativam TODOS os outros lotes do evento ao ativar um novo) tambem
--     NAO SAO TOCADAS -- os novos lotes de ingresso unico sao criados por
--     RPCs novas e dedicadas, is_active sempre true, nunca competindo por um
--     unico slot "is_active" (o antigo modelo de "um lote ativo por vez").
--   - flat_price_confirmed (guarda contra preco default $0 ir ao ar sem
--     confirmacao humana) e o trigger trg_invalidate_single_ticket_price
--     (reseta a confirmacao quando uma categoria e ativada) sao mantidos
--     tal como estao -- meu fluxo de escrita sempre confirma o preco no
--     mesmo passo (equivalente ao set_event_single_ticket_price antigo).
--
-- MODELO DE DADOS ESCOLHIDO: 4 colunas novas em registration_batches,
-- nullable, aditivas, sem impacto em lotes com categoria (ficam NULL) nem em
-- lotes de ingresso unico criados ANTES desta migration (tambem ficam NULL
-- -- o resolver abaixo trata NULL nos dois campos de limite como "modo
-- legado pooled", reproduzindo EXATAMENTE o calculo antigo pra esses lotes,
-- e so ativa o calculo por genero quando os dois limites estao preenchidos).
begin;

alter table public.registration_batches
  add column if not exists male_max_confirmed_registrations integer,
  add column if not exists female_max_confirmed_registrations integer,
  add column if not exists male_closed boolean not null default false,
  add column if not exists female_closed boolean not null default false;

alter table public.registration_batches
  drop constraint if exists registration_batches_male_limit_positive;
alter table public.registration_batches
  add constraint registration_batches_male_limit_positive
  check (male_max_confirmed_registrations is null or male_max_confirmed_registrations > 0);

alter table public.registration_batches
  drop constraint if exists registration_batches_female_limit_positive;
alter table public.registration_batches
  add constraint registration_batches_female_limit_positive
  check (female_max_confirmed_registrations is null or female_max_confirmed_registrations > 0);

-- Os dois limites por genero sao preenchidos juntos ou ficam nulos juntos --
-- nunca um sem o outro. Isso mantem o resolver simples (so 2 modos: legado
-- pooled OU split completo por genero, nunca um hibrido ambiguo).
alter table public.registration_batches
  drop constraint if exists registration_batches_gender_limits_together;
alter table public.registration_batches
  add constraint registration_batches_gender_limits_together
  check (
    (male_max_confirmed_registrations is null) = (female_max_confirmed_registrations is null)
  );

comment on column public.registration_batches.male_max_confirmed_registrations is
  'Limite de confirmados so para pricing_gender=male neste lote. NULL = lote legado, usa o pool max_confirmed_registrations compartilhado entre os dois generos (comportamento anterior a esta migration, preservado sem alteracao).';
comment on column public.registration_batches.female_max_confirmed_registrations is
  'Limite de confirmados so para pricing_gender=female neste lote. Ver comentario de male_max_confirmed_registrations.';
comment on column public.registration_batches.male_closed is
  'Encerramento MANUAL do genero masculino neste lote (acao administrativa "Esgotar/Encerrar"), independente da capacidade ainda restante.';
comment on column public.registration_batches.female_closed is
  'Encerramento MANUAL do genero feminino neste lote. Ver comentario de male_closed.';


-- detect_integrity_single_ticket_price_unconfirmed (modulo de integridade,
-- migration 20260819000000) chama get_event_single_ticket_price_status --
-- dependencia real encontrada na auditoria, precisa ser reescrita ANTES de
-- eu poder derrubar essa funcao (senao o scan de integridade quebraria em
-- qualquer evento sem categoria ativa). Nova regra equivalente no modelo de
-- multiplos lotes: "sem categoria ativa, vendas abertas, e nenhum lote de
-- ingresso unico existe" -- no modelo novo nao existe mais um lote
-- "existente porem nao confirmado" (create_single_ticket_batch sempre exige
-- precos reais e confirma na hora), entao a ausencia de qualquer lote e o
-- equivalente exato do estado antigo price_confirmed=false.
create or replace function public.detect_integrity_single_ticket_price_unconfirmed(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event record; v_active_categories integer;
begin
  for v_event in
    select e.id, e.name from public.events e
    where e.organization_id = p_organization_id and (p_event_id is null or e.id = p_event_id) and e.registration_enabled
  loop
    select count(*) into v_active_categories from public.ticket_categories tc where tc.event_id = v_event.id and tc.is_active = true;
    if v_active_categories > 0 then continue; end if;

    if not exists (
      select 1 from public.registration_batches rb
      where rb.event_id = v_event.id
        and not exists (select 1 from public.registration_batch_prices rbp where rbp.batch_id = rb.id)
    ) then
      return query select
        'SINGLE_TICKET_PRICE_NOT_CONFIRMED'::text, 'critical'::text, 'categoria_preco'::text,
        'Preço do ingresso único não configurado'::text,
        'As vendas estão abertas, mas nenhum lote de ingresso único foi configurado ainda.'::text,
        v_event.id, 'event'::text, v_event.id,
        'Configurar preço'::text, '/painel/eventos/' || v_event.id,
        jsonb_build_object('event_name', v_event.name);
    end if;
  end loop;
end; $$;

-- set_event_single_ticket_price/get_event_single_ticket_price_status
-- modelavam preco fixo (1 unico lote, sempre sobrescrito). Substituidas
-- pelas RPCs de multiplos lotes abaixo; nenhum codigo em src/ ou em outra
-- funcao do banco as chama mais (single-ticket-price-manager.tsx removido
-- junto com esta migration; detect_integrity_single_ticket_price_unconfirmed
-- reescrita acima para nao depender mais delas).
drop function if exists public.set_event_single_ticket_price(uuid, numeric, numeric, text);
drop function if exists public.get_event_single_ticket_price_status(uuid);


-- Resolve, para 1 evento + 1 genero, qual lote de INGRESSO UNICO (sem
-- categoria) deve ser vendido agora: entre os lotes elegiveis (confirmados,
-- dentro da janela de datas, nao encerrados manualmente para esse genero, e
-- com vaga restante), pega o de MENOR PRECO para aquele genero -- nunca o de
-- maior sequence_number. Retorna null quando nenhum lote esta disponivel.
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
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
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


-- Ramo SEM categoria reescrito para usar o resolver multi-lote acima em vez
-- de "select o unico lote is_active order by sequence_number limit 1". O
-- ramo COM categoria (p_ticket_category_id is not null) e os 2 guardas de
-- TICKET_CATEGORY_REQUIRED/TICKET_CATEGORY_UNAVAILABLE ficam IDENTICOS ao
-- que ja existia -- nenhuma mudanca de comportamento pra evento com
-- categoria.
create or replace function public.get_registration_pricing_preview(
  p_gender text, p_coupon_code text default null, p_event_id uuid default null, p_ticket_category_id uuid default null
) returns table(batch_id uuid, batch_name text, sequence_number integer, base_amount numeric, discount_amount numeric,
  final_amount numeric, remaining_slots integer, coupon_message text, coupon_type text, discount_percent numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event_id uuid := p_event_id; v_batch public.registration_batches%rowtype; v_coupon record;
  v_gender text := lower(trim(coalesce(p_gender, ''))); v_base numeric; v_discount numeric := 0; v_final numeric;
  v_eligible_categories integer := 0; v_active_categories integer := 0; v_remaining integer; v_max integer; v_confirmed integer;
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

  if v_gender in ('feminino', 'female', 'f') then
    v_base := round(v_batch.female_price, 2);
    if v_batch.female_max_confirmed_registrations is not null then
      select count(*)::integer into v_confirmed from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.event_id = v_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
          and oi.pricing_gender = 'female' and oi.status = 'confirmed' and o.status = 'confirmed';
      v_max := v_batch.female_max_confirmed_registrations;
    else
      select count(*)::integer into v_confirmed from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.event_id = v_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
          and oi.status = 'confirmed' and o.status = 'confirmed';
      v_max := v_batch.max_confirmed_registrations;
    end if;
  elsif v_gender in ('masculino', 'male', 'm') then
    v_base := round(v_batch.male_price, 2);
    if v_batch.male_max_confirmed_registrations is not null then
      select count(*)::integer into v_confirmed from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.event_id = v_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
          and oi.pricing_gender = 'male' and oi.status = 'confirmed' and o.status = 'confirmed';
      v_max := v_batch.male_max_confirmed_registrations;
    else
      select count(*)::integer into v_confirmed from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.event_id = v_event_id and oi.batch_id = v_batch.id and oi.ticket_category_id is null
          and oi.status = 'confirmed' and o.status = 'confirmed';
      v_max := v_batch.max_confirmed_registrations;
    end if;
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


-- create_multi_ticket_order_checkout_legacy calcula o preco de cada item
-- separadamente, mas a versao vigente da RPC ainda grava em todos eles o
-- batch_id calculado a partir do genero escalar do comprador. Isso era
-- indistinguivel enquanto havia um unico lote; com a virada independente,
-- masculino e feminino podem resolver lotes diferentes. Centralizamos a
-- invariavel no ponto de escrita para que qualquer emissao de ingresso unico
-- grave o mesmo lote que o resolver canonico escolhe para pricing_gender.
create or replace function public.assign_single_ticket_batch_by_gender()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch public.registration_batches%rowtype;
begin
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

revoke all on function public.assign_single_ticket_batch_by_gender() from public, anon, authenticated;

drop trigger if exists trg_assign_single_ticket_batch_by_gender on public.order_items;
create trigger trg_assign_single_ticket_batch_by_gender
before insert or update of event_id, ticket_category_id, pricing_gender, batch_id
on public.order_items
for each row execute function public.assign_single_ticket_batch_by_gender();


-- Leitura consolidada pra UI administrativa (Etapa 3): todos os lotes de
-- ingresso unico do evento (com ou sem categoria concorrente), 1 linha por
-- lote, com contagem/disponibilidade JA calculada por genero, pra montar os
-- cards e o resumo sem N chamadas do frontend.
create or replace function public.list_single_ticket_batches(p_event_id uuid)
returns table(
  batch_id uuid, name text, sequence_number integer,
  male_price numeric, female_price numeric,
  male_max integer, female_max integer, gender_split boolean,
  male_confirmed integer, female_confirmed integer,
  male_closed boolean, female_closed boolean,
  starts_at timestamptz, ends_at timestamptz,
  male_status text, female_status text
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.view') then
    raise exception 'Sem permissao para visualizar o evento.';
  end if;
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  return query
  select
    rb.id, rb.name, rb.sequence_number, rb.male_price, rb.female_price,
    coalesce(rb.male_max_confirmed_registrations, rb.max_confirmed_registrations),
    coalesce(rb.female_max_confirmed_registrations, rb.max_confirmed_registrations),
    rb.male_max_confirmed_registrations is not null,
    (select count(*)::integer from public.order_items oi join public.orders o on o.id = oi.order_id
      where oi.event_id = p_event_id and oi.batch_id = rb.id and oi.ticket_category_id is null
        and (rb.male_max_confirmed_registrations is null or oi.pricing_gender = 'male')
        and oi.status = 'confirmed' and o.status = 'confirmed'),
    (select count(*)::integer from public.order_items oi join public.orders o on o.id = oi.order_id
      where oi.event_id = p_event_id and oi.batch_id = rb.id and oi.ticket_category_id is null
        and rb.male_max_confirmed_registrations is not null and oi.pricing_gender = 'female'
        and oi.status = 'confirmed' and o.status = 'confirmed'),
    rb.male_closed, rb.female_closed, rb.starts_at, rb.ends_at,
    case
      when rb.male_closed then 'esgotado'
      when rb.starts_at is not null and now() < rb.starts_at then 'futuro'
      when rb.ends_at is not null and now() > rb.ends_at then 'esgotado'
      when (select count(*)::integer from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.event_id = p_event_id and oi.batch_id = rb.id and oi.ticket_category_id is null
          and (rb.male_max_confirmed_registrations is null or oi.pricing_gender = 'male')
          and oi.status = 'confirmed' and o.status = 'confirmed')
        >= coalesce(rb.male_max_confirmed_registrations, rb.max_confirmed_registrations) then 'esgotado'
      else 'disponivel'
    end,
    case
      when rb.female_closed then 'esgotado'
      when rb.starts_at is not null and now() < rb.starts_at then 'futuro'
      when rb.ends_at is not null and now() > rb.ends_at then 'esgotado'
      when (select count(*)::integer from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.event_id = p_event_id and oi.batch_id = rb.id and oi.ticket_category_id is null
          and (rb.male_max_confirmed_registrations is null or oi.pricing_gender = 'female')
          and oi.status = 'confirmed' and o.status = 'confirmed')
        >= coalesce(rb.female_max_confirmed_registrations, rb.max_confirmed_registrations) then 'esgotado'
      else 'disponivel'
    end
  from public.registration_batches rb
  where rb.event_id = p_event_id
    and not exists (select 1 from public.registration_batch_prices rbp where rbp.batch_id = rb.id)
  order by rb.sequence_number asc;
end; $$;

revoke all on function public.list_single_ticket_batches(uuid) from public, anon;
grant execute on function public.list_single_ticket_batches(uuid) to authenticated, service_role;


-- Cria um novo lote de ingresso unico. Sempre com preco confirmado
-- (flat_price_confirmed=true) e sempre is_active=true -- neste modelo,
-- "futuro" nao e um lote inativo, e um lote cuja janela/preco ainda nao o
-- torna o mais barato disponivel (ver resolve_single_ticket_batch_for_gender).
create or replace function public.create_single_ticket_batch(
  p_event_id uuid, p_name text, p_sequence_number integer,
  p_male_price numeric, p_female_price numeric,
  p_male_max integer, p_female_max integer,
  p_starts_at timestamptz default null, p_ends_at timestamptz default null,
  p_male_closed boolean default false, p_female_closed boolean default false
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

  if p_male_price is null or p_male_price < 0 or p_female_price is null or p_female_price < 0 then
    raise exception 'Precos do ingresso unico devem ser maiores ou iguais a zero.';
  end if;
  if p_male_max is null or p_male_max <= 0 or p_female_max is null or p_female_max <= 0 then
    raise exception 'Informe limite de vagas masculino e feminino, maiores que zero.';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nome do lote obrigatorio.'; end if;
  if p_sequence_number is null or p_sequence_number <= 0 then raise exception 'Ordem do lote invalida.'; end if;

  insert into public.registration_batches (
    event_id, name, sequence_number, male_price, female_price, max_confirmed_registrations,
    male_max_confirmed_registrations, female_max_confirmed_registrations,
    starts_at, ends_at, is_active, flat_price_confirmed, male_closed, female_closed
  ) values (
    p_event_id, trim(p_name), p_sequence_number, round(p_male_price, 2), round(p_female_price, 2), p_male_max + p_female_max,
    p_male_max, p_female_max, p_starts_at, p_ends_at, true, true, coalesce(p_male_closed, false), coalesce(p_female_closed, false)
  ) returning id into v_batch_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('single_ticket_batch_created', 'registration_batches', v_batch_id, p_event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'name', trim(p_name), 'sequence_number', p_sequence_number,
    'male_price', round(p_male_price, 2), 'female_price', round(p_female_price, 2),
    'male_max', p_male_max, 'female_max', p_female_max,
    'male_closed', coalesce(p_male_closed, false), 'female_closed', coalesce(p_female_closed, false)
  ));

  return v_batch_id;
end; $$;

revoke all on function public.create_single_ticket_batch(uuid, text, integer, numeric, numeric, integer, integer, timestamptz, timestamptz, boolean, boolean) from public, anon;
grant execute on function public.create_single_ticket_batch(uuid, text, integer, numeric, numeric, integer, integer, timestamptz, timestamptz, boolean, boolean) to authenticated, service_role;


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

revoke all on function public.update_single_ticket_batch(uuid, text, numeric, numeric, integer, integer, timestamptz, timestamptz) from public, anon;
grant execute on function public.update_single_ticket_batch(uuid, text, numeric, numeric, integer, integer, timestamptz, timestamptz) to authenticated, service_role;


-- Virada manual: "Esgotar/Encerrar" ou "Reabrir" um genero especifico de um
-- lote. Reabrir e seguro por construcao -- a disponibilidade real sempre e
-- recalculada em tempo real por resolve_single_ticket_batch_for_gender (que
-- reconfere janela de datas e capacidade a cada chamada), entao reabrir um
-- lote sem vaga ou fora da janela simplesmente nao o torna selecionavel.
create or replace function public.set_single_ticket_batch_gender_closed(
  p_batch_id uuid, p_gender text, p_closed boolean
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_batch public.registration_batches%rowtype; v_event public.events%rowtype;
  v_gender text := case
    when lower(trim(coalesce(p_gender, ''))) in ('feminino', 'female', 'f') then 'female'
    when lower(trim(coalesce(p_gender, ''))) in ('masculino', 'male', 'm') then 'male'
    else null
  end;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;
  if v_gender is null then raise exception 'Genero invalido.'; end if;

  select * into v_batch from public.registration_batches where id = p_batch_id for update;
  if not found then raise exception 'Lote nao encontrado.'; end if;
  select * into v_event from public.events where id = v_batch.event_id;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  if v_gender = 'male' then
    update public.registration_batches set male_closed = coalesce(p_closed, false), updated_at = now() where id = p_batch_id;
  else
    update public.registration_batches set female_closed = coalesce(p_closed, false), updated_at = now() where id = p_batch_id;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    case when coalesce(p_closed, false) then 'single_ticket_batch_gender_closed' else 'single_ticket_batch_gender_reopened' end,
    'registration_batches', p_batch_id, v_batch.event_id,
    jsonb_build_object('actor_user_id', v_actor, 'gender', v_gender, 'closed', coalesce(p_closed, false))
  );

  return true;
end; $$;

revoke all on function public.set_single_ticket_batch_gender_closed(uuid, text, boolean) from public, anon;
grant execute on function public.set_single_ticket_batch_gender_closed(uuid, text, boolean) to authenticated, service_role;


-- Preview administrativo: qual lote seria efetivamente usado agora, para
-- CADA genero (podem divergir). Usado pela Etapa 3 (preview do comprador +
-- resumo "Lote atual masc./fem.").
create or replace function public.get_single_ticket_current_batches(p_event_id uuid)
returns table(
  gender text, batch_id uuid, batch_name text, sequence_number integer, price numeric
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_event public.events%rowtype; v_male public.registration_batches%rowtype; v_female public.registration_batches%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.view') then
    raise exception 'Sem permissao para visualizar o evento.';
  end if;
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  select * into v_male from public.resolve_single_ticket_batch_for_gender(p_event_id, 'male');
  select * into v_female from public.resolve_single_ticket_batch_for_gender(p_event_id, 'female');

  return query select 'male'::text, v_male.id, v_male.name, v_male.sequence_number, v_male.male_price
  union all
  select 'female'::text, v_female.id, v_female.name, v_female.sequence_number, v_female.female_price;
end; $$;

revoke all on function public.get_single_ticket_current_batches(uuid) from public, anon;
grant execute on function public.get_single_ticket_current_batches(uuid) to authenticated, service_role;

commit;
