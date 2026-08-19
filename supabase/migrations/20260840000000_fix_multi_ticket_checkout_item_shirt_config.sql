-- Bug: no carrinho ("Seu carrinho", CartStep), 2+ ingressos do mesmo pedido
-- com camiseta/tamanho DIFERENTES entre si apareciam todos com a
-- configuracao do PRIMEIRO ingresso duplicada (ex.: "Camiseta / P" nas duas
-- linhas, quando o segundo deveria ser "Babylook / M"). O Resumo da compra
-- lateral (wizard.tsx, summaryValues.groupedShirts) mostrava certo porque
-- deriva de checkoutItems -- estado client-side de ANTES do pedido existir,
-- nunca lido do banco.
--
-- Causa raiz: create_multi_ticket_order_checkout_legacy (definida no dump
-- 20260815001914_remote_schema.sql, ainda a implementacao real por tras da
-- cadeia de renomeacoes create_multi_ticket_order_checkout ->
-- ..._inventory_legacy -> ..._legacy) itera 1..p_quantity e, pra cada
-- iteracao, MONTA v_item_payload = p_items[i] corretamente (e le dali
-- ownership_status/holder_full_name/holder_email/holder_phone por item, sem
-- problema) -- mas na hora de gravar order_items.shirt_type/shirt_size,
-- ignora v_item_payload e usa direto os parametros escalares de topo
-- p_shirt_type/p_shirt_size (o mesmo valor em TODAS as linhas do loop). Esses
-- parametros escalares chegam do frontend (src/app/inscricao/actions.ts,
-- createOrderRpcPayload) como firstItem?.shirt_type/shirt_size -- ou seja, a
-- config do PRIMEIRO ingresso, replicada pra todos os demais order_items no
-- INSERT, mesmo que cada item em p_items carregue seu proprio shirt_type/
-- shirt_size (o payload que chega do frontend ja esta correto por item; so o
-- INSERT dentro do loop nunca olhava pra ele).
--
-- Confirmando que nao e coincidencia: a funcao WRAPPER que chama esta (hoje
-- renomeada create_multi_ticket_order_checkout_inventory_legacy) ja calcula
-- v_raw_type/v_raw_size por item exatamente com
-- `coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')` -- so pra
-- turbinar o estoque temporariamente antes do INSERT. O INSERT em si, dentro
-- desta funcao mais interna, nunca replicou essa mesma logica per-item.
--
-- Correcao: dentro do loop, resolver v_item_shirt_type/v_item_shirt_size com
-- a mesma prioridade (item do payload primeiro, scalar como fallback --
-- preserva o comportamento do fluxo de ingresso unico, que nunca populou
-- p_items[i].shirt_type) e gravar esses valores por linha, em vez do scalar
-- fixo. Nenhuma outra coluna/regra (preco, cupom, estoque, titularidade) e
-- alterada -- e o restante do corpo da funcao e identico ao da versao
-- anterior.
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

  v_total_amount := round(coalesce(v_pricing.base_amount, 0) * p_quantity, 2);
  v_total_discount := round(coalesce(v_pricing.discount_amount, 0) * p_quantity, 2);
  v_total_final := round(coalesce(v_pricing.final_amount, 0) * p_quantity, 2);

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

    -- Fix: cada ingresso grava a PROPRIA camiseta/tamanho (v_item_payload),
    -- nao mais o parametro escalar de topo replicado pra todo o loop. O
    -- scalar p_shirt_type/p_shirt_size continua servindo de fallback quando
    -- o item nao especifica (fluxo de ingresso unico, que nunca populou
    -- p_items[i].shirt_type) -- mesma prioridade ja usada pela funcao wrapper
    -- (create_multi_ticket_order_checkout_inventory_legacy) pra turbinar
    -- estoque antes de chamar esta funcao.
    v_item_shirt_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_item_shirt_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

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
      coalesce(v_pricing.base_amount, 0),
      coalesce(v_pricing.discount_amount, 0),
      coalesce(v_pricing.final_amount, 0),
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
