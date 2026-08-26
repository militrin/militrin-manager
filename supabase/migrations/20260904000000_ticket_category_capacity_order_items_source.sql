begin;

-- P0 -- corrige overselling de capacidade de categoria no fluxo moderno.
--
-- CAUSA-RAIZ (confirmada em runtime, ver validacao da migration 103 e
-- auditoria desta tarefa):
-- get_event_ticket_categories() calculava available_slots exclusivamente a
-- partir de public.participants.reservation_status. No modelo moderno
-- (order_items), participants so existe para:
--   (a) o item ownership_mode='self' (materialize_self_checkout_holder);
--   (b) itens ownership_mode='named' (materialize_named_checkout_holders) --
--       mas esta insercao NUNCA preenche participants.ticket_category_id,
--       entao o stats original (`where p.ticket_category_id is not null`)
--       tambem excluia titulares nomeados, nao so os nao atribuidos;
--   itens ownership_mode='unassigned' nunca ganham participants.
-- Resultado comprovado: um pedido de 3 ingressos pagos podia consumir
-- apenas 1 vaga (ou ate 0, se o unico item com participante for nomeado).
-- create_multi_ticket_order_checkout_legacy ja tinha uma compensacao manual
-- (subtrair order_items com participant_id null), mas ela e incompleta (nao
-- cobre o caso "nomeado" acima, que perde o participant_id null exatamente
-- quando materialize_named_checkout_holders roda) e so existia neste UM
-- ponto de checagem -- toda tela que exibe available_slots continuava errada.
--
-- REGRA DE NEGOCIO (conforme solicitado): a capacidade pertence ao INGRESSO
-- (order_items), nao ao titular. 1 order_item de ingresso reservado/confirmado
-- = 1 vaga ocupada, com 0 ou 1 titular, independente de quem/quando é
-- atribuido. Produtos/add-ons (order_items.item_kind='product') nunca tem
-- ticket_category_id (order_items_product_kind_shape_check ja garante isso),
-- entao nunca consomem capacidade de ingresso.
--
-- FONTE CANONICA ESCOLHIDA: order_items (por ticket_category_id + status)
-- para o fluxo moderno. Coexistencia com o legado: public.create_registration()
-- (unico fluxo que so gravava participants, sem order_items) esta REVOGADO
-- desde 20260820000000 -- zero consumidores vivos hoje. Ainda assim, pra nao
-- quebrar QUALQUER dado historico de antes dessa revogacao, o novo calculo
-- soma um residuo legado: participants com ticket_category_id preenchido que
-- NUNCA tem nenhum order_items vinculado (NOT EXISTS). Um participant que E
-- projecao de um order_item moderno (self ou named) e explicitamente
-- excluido desse residuo, entao nunca e contado 2x (nem via participants,
-- nem via order_items, ao mesmo tempo).
--
-- CONCORRENCIA: create_multi_ticket_order_checkout_legacy ja fazia
-- `select * from events where id=p_event_id for update` ANTES da checagem de
-- capacidade (unico ponto onde available_slots decide se o pedido pode
-- seguir) -- isso serializa toda a transacao de checkout contra qualquer
-- outra transacao de checkout do MESMO evento: a segunda fica bloqueada ate
-- a primeira commitar/abortar, e so entao re-le a contagem, ja atualizada.
-- Essa trava ja existia e nao foi alterada aqui -- so o que ela protege
-- (a contagem em si) estava incorreto. Validado com teste de concorrencia
-- real (2 conexoes simultaneas) na suite de integracao.
--
-- FORA DE ESCOPO NESTA MIGRATION (documentado, nao corrigido):
-- 1) registration_batches/registration_batch_prices.max_confirmed_registrations
--    (current_batch, mais abaixo) ainda conta so via participants+payments
--    (join por participant_id, que pagamento moderno nunca preenche) -- e
--    progressao de LOTE/PRECO, um mecanismo diferente de capacidade de
--    categoria, e igualmente afetado, mas fica fora do escopo desta correcao
--    de overselling.
-- 2) owner_cancel_ticket() (cancelamento administrativo direto de um ticket)
--    so atualiza tickets.status, nunca order_items.status -- um ticket
--    cancelado pelo admin NAO libera a vaga sob esta nova fonte (nem liberava
--    sob a antiga). Reembolso via _apply_terminal_order_payment_status(...,
--    'refunded') JA seta order_items.status='refunded', entao libera
--    automaticamente com esta correcao, sem precisar de mudanca adicional.
-- 3) create_manual_registration_order/create_manual_unassigned_ticket_order
--    (emissao administrativa/cortesia) nunca checaram capacidade e nao travam
--    o evento -- comportamento preexistente, tratado como override
--    intencional de staff, nao alterado aqui.

-- ============================================================
-- 1. get_event_ticket_categories -- nova fonte de reserved/confirmed/pending.
-- ============================================================
create or replace function public.get_event_ticket_categories(p_event_id uuid default null::uuid) returns table(id uuid, event_id uuid, name text, slug text, description text, capacity integer, is_active boolean, sort_order integer, confirmed_count integer, pending_count integer, reserved_count integer, available_slots integer, current_batch_id uuid, current_batch_name text, current_batch_sequence integer, current_male_price numeric, current_female_price numeric, created_at timestamp with time zone, updated_at timestamp with time zone)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_event_id uuid := p_event_id;
begin
  if v_event_id is null then
    select e.id into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  return query
  with modern_stats as (
    -- Fonte canonica moderna: 1 order_items de ingresso = 1 vaga ocupada,
    -- com ou sem titular. item_kind='product' (produtos/add-ons/camisetas
    -- avulsas) nunca tem ticket_category_id (order_items_product_kind_shape_check),
    -- entao ja fica fora deste agrupamento sem precisar de filtro extra.
    -- Atribuir/remover/trocar titular so mexe em participant_id/ownership_status,
    -- nunca em status -- a vaga nao muda com isso.
    select
      oi.ticket_category_id,
      count(*) filter (where oi.status = 'confirmed')::integer as confirmed_count,
      count(*) filter (where oi.status = 'reserved')::integer as pending_count
    from public.order_items oi
    where oi.event_id = v_event_id
      and oi.ticket_category_id is not null
    group by oi.ticket_category_id
  ),
  legacy_stats as (
    -- Residuo legado: SOMENTE participant que nunca passou pelo fluxo
    -- moderno (sem nenhum order_items vinculado). create_registration()
    -- (unico fluxo que so usava participants, sem order_items) esta
    -- desativado desde 20260820000000 -- este ramo existe por
    -- compatibilidade com dados historicos, nao por um fluxo vivo.
    -- Participants que SAO projecao de um order_items moderno (self/named)
    -- ja foram contados acima via modern_stats e sao excluidos aqui pelo
    -- NOT EXISTS, pra nunca contar a mesma vaga 2x.
    select
      p.ticket_category_id,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status = 'confirmed'
      )::integer as confirmed_count,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status = 'pending'
      )::integer as pending_count
    from public.participants p
    where p.event_id = v_event_id
      and p.ticket_category_id is not null
      and not exists (
        select 1 from public.order_items oi2 where oi2.participant_id = p.id
      )
      -- create_multi_ticket_order_checkout_legacy sempre cria/reusa um
      -- participant "anchor" do comprador (dedup por CPF), mesmo quando
      -- p_assign_first_to_buyer=false ou depois que o item que o linkava
      -- perde o participant_id (troca/remocao de titular): esse anchor
      -- continua existindo com ticket_category_id preenchido mas SEM
      -- nenhum order_items apontando pra ele -- sem esta exclusao ele caia
      -- aqui como se fosse uma vaga legada de verdade (contado 2x: 1x pelo
      -- order_item real via modern_stats, 1x pelo anchor orfao aqui).
      -- orders.participant_id so aponta pra esse anchor no modelo moderno;
      -- um participant 100% legado (pre-order_items) nunca tem nenhuma
      -- linha em orders referenciando-o.
      and not exists (
        select 1 from public.orders o where o.participant_id = p.id
      )
    group by p.ticket_category_id
  ),
  stats as (
    select
      coalesce(m.ticket_category_id, l.ticket_category_id) as ticket_category_id,
      coalesce(m.confirmed_count, 0) + coalesce(l.confirmed_count, 0) as confirmed_count,
      coalesce(m.pending_count, 0) + coalesce(l.pending_count, 0) as pending_count,
      coalesce(m.confirmed_count, 0) + coalesce(l.confirmed_count, 0)
        + coalesce(m.pending_count, 0) + coalesce(l.pending_count, 0) as reserved_count
    from modern_stats m
    full outer join legacy_stats l on l.ticket_category_id = m.ticket_category_id
  ),
  current_batch as (
    -- ACHADO SEPARADO, NAO CORRIGIDO NESTA MIGRATION: max_confirmed_registrations
    -- abaixo tambem so conta via participants+payments (join por participant_id,
    -- que pagamentos modernos nunca preenchem) -- e um mecanismo diferente
    -- (progressao de lote/preco), nao capacidade/overselling de categoria,
    -- por isso ficou fora do escopo desta correcao. Documentado no relatorio.
    select distinct on (rbp.ticket_category_id)
      rbp.ticket_category_id,
      rb.id as batch_id,
      rb.name as batch_name,
      rb.sequence_number,
      rbp.male_price,
      rbp.female_price
    from public.registration_batch_prices rbp
    join public.registration_batches rb on rb.id = rbp.batch_id
    where rb.event_id = v_event_id
      and rb.is_active = true
      and (
        rbp.max_confirmed_registrations is null
        or coalesce((
          select count(*)::integer
          from public.participants part
          join public.payments pay on pay.participant_id = part.id
          where part.batch_id = rb.id
            and part.ticket_category_id = rbp.ticket_category_id
            and coalesce(part.registration_status, 'pending') <> 'cancelled'
            and pay.payment_status = 'paid'
            and (part.reservation_status is null or part.reservation_status = 'confirmed')
        ), 0) < rbp.max_confirmed_registrations
      )
      and (rb.ends_at is null or now() <= rb.ends_at)
    order by rbp.ticket_category_id, rb.sequence_number asc
  )
  select
    tc.id,
    tc.event_id,
    tc.name,
    tc.slug,
    tc.description,
    tc.capacity,
    tc.is_active,
    tc.sort_order,
    coalesce(s.confirmed_count, 0),
    coalesce(s.pending_count, 0),
    coalesce(s.reserved_count, 0),
    case
      when tc.capacity is null then null::integer
      else greatest(tc.capacity - coalesce(s.reserved_count, 0), 0)
    end::integer,
    cb.batch_id,
    cb.batch_name,
    cb.sequence_number,
    cb.male_price,
    cb.female_price,
    tc.created_at,
    tc.updated_at
  from public.ticket_categories tc
  left join stats s
    on s.ticket_category_id = tc.id
  left join current_batch cb
    on cb.ticket_category_id = tc.id
  where tc.event_id = v_event_id
  order by tc.sort_order asc, tc.name asc;
end;
$$;

-- ============================================================
-- 2. create_multi_ticket_order_checkout_legacy -- remove a compensacao
--    manual (redundante e incompleta) agora que get_event_ticket_categories
--    ja conta order_items corretamente. Nenhuma outra linha desta funcao foi
--    alterada -- corpo identico ao vigente, exceto o bloco de checagem de
--    capacidade (marcado abaixo).
-- ============================================================
create or replace function public.create_multi_ticket_order_checkout_legacy(p_event_id uuid, p_ticket_category_id uuid, p_gender text, p_quantity integer, p_payment_method text, p_coupon_code text DEFAULT NULL::text, p_shirt_type text DEFAULT NULL::text, p_shirt_size text DEFAULT NULL::text, p_buyer_full_name text DEFAULT NULL::text, p_buyer_cpf text DEFAULT NULL::text, p_buyer_birth_date date DEFAULT NULL::date, p_buyer_gender text DEFAULT NULL::text, p_buyer_phone text DEFAULT NULL::text, p_buyer_email text DEFAULT NULL::text, p_buyer_city text DEFAULT NULL::text, p_assign_first_to_buyer boolean DEFAULT true, p_items jsonb DEFAULT '[]'::jsonb, p_limit_per_order integer DEFAULT 10, p_notes text DEFAULT NULL::text, p_client_request_id text DEFAULT NULL::text)
 returns table(order_id uuid, payment_id uuid, order_number text, payment_status text, reservation_expires_at timestamp with time zone, item_count integer, amount numeric, discount_amount numeric, final_amount numeric)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_event public.events%rowtype;
  v_pricing record;
  v_batch_id uuid;
  v_batch_name text;
  v_order_id uuid;
  v_order_number text;
  v_payment_id uuid;
  v_anchor_participant_id uuid;
  v_reservation_expires_at timestamptz;
  v_item_index integer;
  v_item_payload jsonb;
  v_item_shirt_type text;
  v_item_shirt_size text;
  v_item_gender text;
  v_item_pricing_gender text;
  v_item_pricing record;
  v_item_bases numeric[] := '{}'::numeric[];
  v_item_discounts numeric[] := '{}'::numeric[];
  v_item_finals numeric[] := '{}'::numeric[];
  v_ownership_status text;
  v_holder_name text;
  v_holder_email text;
  v_holder_phone text;
  v_status text := 'reserved';
  v_payment_status text := 'pending';
  v_total_amount numeric := 0;
  v_total_discount numeric := 0;
  v_total_final numeric := 0;
  v_available_category integer;
  v_required_shirt boolean := false;
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_existing_order public.orders%rowtype;
begin
  if v_user_id is null then
    raise exception 'Sessao autenticada obrigatoria.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(p_quantity, 0) < 1 then
    raise exception 'Quantidade minima de ingressos: 1.';
  end if;

  if p_limit_per_order is not null and p_quantity > p_limit_per_order then
    raise exception 'Limite maximo por pedido excedido (%).', p_limit_per_order;
  end if;

  if coalesce(trim(coalesce(p_payment_method, '')), '') not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
  end if;

  if coalesce(trim(coalesce(p_buyer_full_name, '')), '') = '' then
    raise exception 'Nome do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_cpf, '')), '') = '' then
    raise exception 'CPF do comprador obrigatorio.';
  end if;

  if p_buyer_birth_date is null then
    raise exception 'Data de nascimento do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_gender, '')), '') = '' then
    raise exception 'Genero do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_phone, '')), '') = '' then
    raise exception 'Telefone do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_city, '')), '') = '' then
    raise exception 'Cidade do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_email, '')), '') = '' then
    raise exception 'E-mail do comprador obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  if v_event.registration_open_at is not null and v_event.registration_open_at > now() then
    raise exception 'Inscricoes ainda nao abertas para este evento.';
  end if;

  if v_event.registration_close_at is not null and v_event.registration_close_at < now() then
    raise exception 'Inscricoes encerradas para este evento.';
  end if;

  if p_client_request_id is not null and trim(p_client_request_id) <> '' then
    select * into v_existing_order
    from public.orders
    where user_id = v_user_id
      and client_request_id = trim(p_client_request_id)
    limit 1;

    if found then
      select pay.id, pay.payment_status, pay.expires_at, pay.amount, pay.discount_amount, pay.final_amount
      into v_payment_id, v_payment_status, v_reservation_expires_at, v_total_amount, v_total_discount, v_total_final
      from public.payments pay
      where pay.order_id = v_existing_order.id
      order by pay.created_at desc
      limit 1;

      return query
      select
        v_existing_order.id,
        v_payment_id,
        v_existing_order.order_number,
        coalesce(v_payment_status, 'pending'),
        v_reservation_expires_at,
        coalesce((select count(*)::integer from public.order_items oi where oi.order_id = v_existing_order.id), 0),
        coalesce(v_total_amount, 0),
        coalesce(v_total_discount, 0),
        coalesce(v_total_final, 0);
      return;
    end if;
  end if;

  select * into v_pricing
  from public.get_registration_pricing_preview(
    p_gender,
    nullif(trim(coalesce(p_coupon_code, '')), ''),
    p_event_id,
    p_ticket_category_id
  )
  limit 1;

  if v_pricing.batch_id is null then
    raise exception 'Nao foi possivel calcular o preco para a categoria.';
  end if;

  v_batch_id := v_pricing.batch_id;
  v_batch_name := v_pricing.batch_name;

  -- get_event_ticket_categories() agora conta direto de order_items (1 item
  -- de ingresso = 1 vaga, com ou sem titular) -- a subtracao manual de
  -- "v_unassigned_in_category" que existia aqui virou redundante E, pior,
  -- incompleta (nunca cobria order_items com titular NOMEADO cujo
  -- participants.ticket_category_id fica null -- ver migration de
  -- correcao de capacidade). Comparar direto contra available_slots.
  select tc.available_slots
  into v_available_category
  from public.get_event_ticket_categories(p_event_id) tc
  where tc.id = p_ticket_category_id
  limit 1;

  if v_available_category is null then
    v_available_category := 2147483647;
  end if;

  if v_available_category < p_quantity then
    raise exception 'Capacidade da categoria insuficiente para % ingressos.', p_quantity;
  end if;

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
      and eki.is_required = true
  ) into v_required_shirt;

  if v_required_shirt and (coalesce(trim(coalesce(p_shirt_type, '')), '') = '' or coalesce(trim(coalesce(p_shirt_size, '')), '') = '') then
    raise exception 'Camiseta obrigatoria para este evento.';
  end if;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para este modelo e tamanho.';
    end if;

    v_available_stock := coalesce(v_inventory.total_quantity, 0) - coalesce(v_inventory.reserved_quantity, 0) - coalesce(v_inventory.delivered_quantity, 0);
    if v_available_stock < p_quantity then
      raise exception 'Estoque insuficiente para a quantidade solicitada (%).', p_quantity;
    end if;
  end if;

  -- Fix: preco por item, nao mais v_pricing.X (preco do primeiro item, via
  -- p_gender) multiplicado por p_quantity. Cada ingresso resolve o proprio
  -- pricing_gender (mesma prioridade item->scalar da correcao da camiseta) e
  -- chama get_registration_pricing_preview individualmente -- o mesmo RPC
  -- que o frontend ja chama uma vez por item durante o bootstrap de preco.
  -- v_total_amount/discount/final viram a SOMA real das linhas, nao mais uma
  -- multiplicacao que assumia preco uniforme entre ingressos.
  for v_item_index in 1..p_quantity loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    v_item_gender := nullif(trim(coalesce(v_item_payload ->> 'pricing_gender', p_gender, '')), '');

    select * into v_item_pricing
    from public.get_registration_pricing_preview(
      v_item_gender,
      nullif(trim(coalesce(p_coupon_code, '')), ''),
      p_event_id,
      p_ticket_category_id
    )
    limit 1;

    if v_item_pricing.batch_id is null then
      raise exception 'Nao foi possivel calcular o preco do ingresso %.', v_item_index;
    end if;

    v_item_bases[v_item_index] := coalesce(v_item_pricing.base_amount, 0);
    v_item_discounts[v_item_index] := coalesce(v_item_pricing.discount_amount, 0);
    v_item_finals[v_item_index] := coalesce(v_item_pricing.final_amount, 0);

    v_total_amount := v_total_amount + v_item_bases[v_item_index];
    v_total_discount := v_total_discount + v_item_discounts[v_item_index];
    v_total_final := v_total_final + v_item_finals[v_item_index];
  end loop;

  v_total_amount := round(v_total_amount, 2);
  v_total_discount := round(v_total_discount, 2);
  v_total_final := round(v_total_final, 2);

  if lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then
    v_payment_status := 'paid';
    v_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_payment_status := 'pending';
    v_status := 'reserved';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  select p.id into v_anchor_participant_id
  from public.participants p
  where p.event_id = p_event_id
    and regexp_replace(coalesce(p.cpf, ''), '\\D', '', 'g') = regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g')
    and p.user_id = v_user_id
  order by p.created_at asc
  limit 1
  for update;

  if v_anchor_participant_id is null then
    insert into public.participants (
      event_id, full_name, cpf, birth_date, gender, phone, email, city, shirt_type, shirt_size,
      registration_status, notes, reservation_status, reservation_expires_at, batch_id,
      base_amount, discount_amount, final_amount, ticket_category_id, user_id
    ) values (
      p_event_id,
      trim(p_buyer_full_name),
      regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g'),
      p_buyer_birth_date,
      trim(p_buyer_gender),
      regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      lower(trim(p_buyer_email)),
      trim(p_buyer_city),
      coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'),
      coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      coalesce(nullif(trim(coalesce(p_notes, '')), ''), 'Anchor participante do checkout multi-ingressos'),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      v_reservation_expires_at,
      v_batch_id,
      coalesce(v_pricing.base_amount, 0),
      coalesce(v_pricing.discount_amount, 0),
      coalesce(v_pricing.final_amount, 0),
      p_ticket_category_id,
      v_user_id
    ) returning id into v_anchor_participant_id;
  else
    update public.participants
    set
      full_name = trim(p_buyer_full_name),
      birth_date = p_buyer_birth_date,
      gender = trim(p_buyer_gender),
      phone = regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      email = lower(trim(p_buyer_email)),
      city = trim(p_buyer_city),
      shirt_type = coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), shirt_type),
      shirt_size = coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), shirt_size),
      registration_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_expires_at = v_reservation_expires_at,
      batch_id = v_batch_id,
      base_amount = coalesce(v_pricing.base_amount, 0),
      discount_amount = coalesce(v_pricing.discount_amount, 0),
      final_amount = coalesce(v_pricing.final_amount, 0),
      ticket_category_id = p_ticket_category_id,
      updated_at = now()
    where id = v_anchor_participant_id;
  end if;

  v_order_number := public.generate_order_number();

  insert into public.orders (
    user_id, participant_id, event_id, payment_id, order_number, status,
    base_amount, discount_amount, final_amount, confirmed_at, cancelled_at, client_request_id
  ) values (
    v_user_id,
    v_anchor_participant_id,
    p_event_id,
    null,
    v_order_number,
    case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
    v_total_amount,
    v_total_discount,
    v_total_final,
    case when v_payment_status = 'paid' then now() else null end,
    null,
    nullif(trim(coalesce(p_client_request_id, '')), '')
  ) returning id into v_order_id;

  insert into public.payments (
    participant_id, event_id, amount, discount_amount, final_amount, payment_method,
    payment_status, paid_at, expires_at, order_id
  ) values (
    v_anchor_participant_id,
    p_event_id,
    v_total_amount,
    v_total_discount,
    v_total_final,
    trim(p_payment_method),
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end,
    v_reservation_expires_at,
    v_order_id
  ) returning id into v_payment_id;

  for v_item_index in 1..p_quantity loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    -- Fix (20260840000000): cada ingresso grava a PROPRIA camiseta/tamanho
    -- (v_item_payload), nao mais o parametro escalar de topo replicado pra
    -- todo o loop. O scalar p_shirt_type/p_shirt_size continua servindo de
    -- fallback quando o item nao especifica (fluxo de ingresso unico, que
    -- nunca populou p_items[i].shirt_type).
    v_item_shirt_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_item_shirt_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

    -- Fix (20260846000000): mesma prioridade item->escalar ja usada pro
    -- calculo de preco (primeiro loop, v_item_gender) -- so que aqui o
    -- resultado e normalizado pros dois tokens canonicos ('male'/'female')
    -- e GRAVADO em order_items.pricing_gender, nunca descartado depois de
    -- calcular o preco. Um valor em formato inesperado vira null (nunca um
    -- terceiro token fora do check constraint) -- consistente com "nao
    -- inferir silenciosamente": se nao da pra reconhecer o genero, fica
    -- nao registrado, nao adivinhado.
    v_item_gender := lower(trim(coalesce(v_item_payload ->> 'pricing_gender', p_gender, '')));
    v_item_pricing_gender := case
      when v_item_gender in ('female', 'feminino', 'f') then 'female'
      when v_item_gender in ('male', 'masculino', 'm') then 'male'
      else null
    end;

    -- Fix (20260842000000): a checagem de "camiseta obrigatoria" antes deste
    -- loop so olhava pro item 1 (p_shirt_type/p_shirt_size escalares). Um
    -- payload com o item 1 preenchido e os itens 2..N sem shirt_type/
    -- shirt_size passava por ali sem erro e cada item 2..N nascia com o
    -- fallback pro escalar (bug 20260840000000) OU, se nem o escalar
    -- estivesse preenchido, com shirt_type/shirt_size null -- nunca
    -- rejeitado, mesmo o evento exigindo camiseta pra todo ingresso. Agora,
    -- pra evento com camiseta obrigatoria, CADA item resolvido sem
    -- shirt_type ou sem shirt_size aborta a transacao inteira (orders/
    -- payments ja inseridos nesta chamada sao desfeitos automaticamente),
    -- identificando o ingresso especifico na mensagem.
    if v_required_shirt and (v_item_shirt_type is null or v_item_shirt_size is null) then
      raise exception 'Camiseta obrigatoria para o ingresso %.', v_item_index;
    end if;

    v_ownership_status := lower(trim(coalesce(v_item_payload ->> 'ownership_status', case when p_assign_first_to_buyer and v_item_index = 1 then 'assigned' else 'unassigned' end)));
    v_holder_name := nullif(trim(coalesce(v_item_payload ->> 'holder_full_name', '')), '');
    v_holder_email := nullif(lower(trim(coalesce(v_item_payload ->> 'holder_email', ''))), '');
    v_holder_phone := nullif(regexp_replace(coalesce(v_item_payload ->> 'holder_phone', ''), '\\D', '', 'g'), '');

    if v_ownership_status not in ('unassigned', 'assigned', 'transferred', 'cancelled') then
      v_ownership_status := 'unassigned';
    end if;

    if v_ownership_status = 'assigned' and not (p_assign_first_to_buyer and v_item_index = 1) then
      v_ownership_status := 'unassigned';
    end if;

    insert into public.order_items (
      order_id, event_id, participant_id, ownership_status, ticket_category_id, batch_id,
      shirt_type, shirt_size, pricing_gender, quantity, unit_price, discount_amount, final_amount, status,
      reservation_expires_at, item_position, holder_full_name, holder_email, holder_phone
    ) values (
      v_order_id,
      p_event_id,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then v_anchor_participant_id else null end,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then 'assigned' else 'unassigned' end,
      p_ticket_category_id,
      v_batch_id,
      v_item_shirt_type,
      v_item_shirt_size,
      v_item_pricing_gender,
      1,
      v_item_bases[v_item_index],
      v_item_discounts[v_item_index],
      v_item_finals[v_item_index],
      v_status,
      v_reservation_expires_at,
      v_item_index,
      v_holder_name,
      v_holder_email,
      v_holder_phone
    );
  end loop;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    update public.shirt_inventory
    set reserved_quantity = reserved_quantity + p_quantity,
        updated_at = now()
    where id = v_inventory.id;

    insert into public.inventory_movements (
      event_id, inventory_id, movement_type, quantity, notes
    ) values (
      p_event_id,
      v_inventory.id,
      'adjustment',
      -p_quantity,
      format('Reserva checkout multi (%s) pedido %s.', p_quantity, v_order_number)
    );
  end if;

  if coalesce(v_event.kit_enabled, false) then
    insert into public.participant_kit_items (
      participant_id, event_id, kit_item_id, variant_data, quantity, status
    )
    select
      v_anchor_participant_id,
      p_event_id,
      eki.id,
      case
        when eki.item_type = 'shirt' then jsonb_build_object('shirt_type', coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'), 'shirt_size', coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'))
        else null
      end,
      eki.quantity_per_participant,
      case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.is_active = true
    on conflict (order_item_id, kit_item_id)
    do update set
      quantity = excluded.quantity,
      status = excluded.status,
      variant_data = excluded.variant_data;
  end if;

  if v_payment_status = 'paid' then
    perform public.confirm_order_payment_and_issue_tickets(v_order_id);
  end if;

  return query
  select
    v_order_id,
    v_payment_id,
    v_order_number,
    v_payment_status,
    v_reservation_expires_at,
    p_quantity,
    v_total_amount,
    v_total_discount,
    v_total_final;
end;
$function$;

-- ============================================================
-- 3. Indice de suporte -- get_event_ticket_categories e a checagem de
--    capacidade do checkout agora agrupam/filtram order_items por
--    (ticket_category_id, status) o tempo todo; nao existia indice nenhum
--    cobrindo essa combinacao (so event_id/order_id).
-- ============================================================
create index if not exists idx_order_items_ticket_category_status
  on public.order_items (ticket_category_id, status)
  where ticket_category_id is not null;

commit;
