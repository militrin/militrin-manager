-- Bug: com quantidade > 1 e camiseta obrigatoria pro evento (event_kit_items
-- com item_type='shirt', is_active=true, is_required=true -- a MESMA fonte
-- canonica que o frontend ja usa pra decidir hasRequiredShirt em wizard.tsx),
-- dava pra chegar na etapa de Revisao com ingressos #2/#3/#4 mostrando
-- "-- / --" (shirt_type/shirt_size vazios) mesmo o evento exigindo camiseta
-- pra todo ingresso.
--
-- Causa raiz (confirmada em duas camadas):
--
-- 1) FRONTEND: a navegacao por abas do topo (trail, "Escolha seu ingresso /
--    Seus dados / Pagamento / Concluido") chama goTo(target) direto --
--    ver wizard.tsx, funcao goTo -- que so checava `next > maxUnlockedStep`,
--    nunca revalidando checkoutItems. validateCheckoutItems() (que ja
--    checava camiseta/genero/titular POR ITEM corretamente, com indice real,
--    nunca so o primeiro) so era chamada em handleChooseTicketNext (Etapa 1
--    -> 2). Uma vez que maxUnlockedStep>=3 (por ja ter completado o fluxo
--    uma vez), dava pra voltar pra Etapa 1, aumentar quantidade ou apagar a
--    camiseta de um item, e clicar direto na aba "Pagamento"/Revisao pelo
--    trail -- pulando toda validacao.
--
-- 2) BACKEND: create_multi_ticket_order_checkout_legacy so validava
--    "camiseta obrigatoria" usando os parametros ESCALARES de topo
--    p_shirt_type/p_shirt_size (o mesmo padrao de bug ja corrigido pra
--    shirt_type/shirt_size por item em 20260840000000, e pra unit_price por
--    item em 20260841000000) -- ou seja, mesmo que o frontend tivesse sido
--    manipulado ou tivesse outro bug, um payload com o item 1 preenchido e
--    os itens 2..N com shirt_type/shirt_size ausentes passava pela unica
--    checagem existente (que so olha pro item 1) e os itens 2..N eram
--    inseridos em order_items com o fallback pro escalar do item 1 (pos
--    20260840000000) -- nunca REJEITADOS como deveriam quando o evento exige
--    camiseta.
--
-- Correcao:
-- 1) Frontend (wizard.tsx): goTo() agora revalida checkoutItems antes de
--    permitir qualquer navegacao pra Etapa 2+ (nao so a primeira vez) --
--    trail, botoes "Voltar"/"Avancar" e qualquer chamada futura passam pelo
--    mesmo guard. Falha aponta pro primeiro ingresso incompleto (mensagem +
--    scroll/foco) e nunca mostra Revisao/Pagamento com dado faltando.
-- 2) Backend: create_multi_ticket_order_checkout_legacy passa a validar,
--    DENTRO do loop que ja resolve shirt_type/shirt_size por item (a mesma
--    fonte v_item_payload->>'shirt_type' com fallback pro escalar, ja
--    corrigida em 20260840000000), se v_required_shirt e o item resultou sem
--    shirt_type OU sem shirt_size -- rejeitando o pedido inteiro (mesma
--    transacao, orders/payments ja inseridos sao desfeitos automaticamente)
--    e identificando QUAL ingresso esta incompleto na mensagem. A checagem
--    antiga (so item 1, antes do loop) e mantida intacta como fast-path --
--    a nova e estritamente um superset, nunca substitui regra existente.
begin;

create or replace function public.create_multi_ticket_order_checkout_legacy(
  p_event_id uuid, p_ticket_category_id uuid, p_gender text, p_quantity integer, p_payment_method text,
  p_coupon_code text default null, p_shirt_type text default null, p_shirt_size text default null,
  p_buyer_full_name text default null, p_buyer_cpf text default null, p_buyer_birth_date date default null,
  p_buyer_gender text default null, p_buyer_phone text default null, p_buyer_email text default null, p_buyer_city text default null,
  p_assign_first_to_buyer boolean default true, p_items jsonb default '[]'::jsonb, p_limit_per_order integer default 10,
  p_notes text default null, p_client_request_id text default null
) returns table(order_id uuid, payment_id uuid, order_number text, payment_status text, reservation_expires_at timestamptz,
  item_count integer, amount numeric, discount_amount numeric, final_amount numeric)
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
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
  v_unassigned_in_category integer := 0;
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

  select tc.available_slots
  into v_available_category
  from public.get_event_ticket_categories(p_event_id) tc
  where tc.id = p_ticket_category_id
  limit 1;

  if v_available_category is null then
    v_available_category := 2147483647;
  end if;

  select count(*)::integer into v_unassigned_in_category
  from public.order_items oi
  where oi.event_id = p_event_id
    and oi.ticket_category_id = p_ticket_category_id
    and oi.participant_id is null
    and oi.status in ('reserved', 'confirmed');

  if (v_available_category - v_unassigned_in_category) < p_quantity then
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
      shirt_type, shirt_size, quantity, unit_price, discount_amount, final_amount, status,
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
$$;

commit;
