-- duplicate_event_configuration (usada em src/app/eventos/actions.ts, feature
-- "Duplicar evento") ainda inseria em public.coupons usando as colunas
-- legadas coupon_type/discount_percent, removidas pela reorganizacao de
-- cupons em organizacao/escopo. Sem este ajuste, duplicar um evento com
-- "copiar cupons" marcado quebrava em runtime (column "coupon_type" of
-- relation "coupons" does not exist), achado via `supabase db lint --local`.
--
-- Reescrita preserva a intencao original -- gerar uma copia independente,
-- inativa, com used_count zerado, de cada cupom que hoje pertence
-- especificamente ao evento de origem (possui linha em coupon_event_scopes
-- para p_source_event_id) e se aplica a ingressos -- agora usando
-- organization_id/discount_type/discount_value e recriando o escopo
-- (coupon_event_scopes, e coupon_ticket_category_scopes quando as categorias
-- tambem foram copiadas, casadas por slug). Cupons "todos os eventos" nao sao
-- duplicados (nao pertencem especificamente ao evento de origem) e o
-- escopo de produtos nunca e copiado, pois produtos sao por evento e esta
-- funcao nao duplica produtos.
begin;

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
  v_org uuid;
  v_coupon record;
  v_new_coupon_id uuid;
  v_new_code text;
  v_suffix integer;
begin
  if p_source_event_id is null then
    raise exception 'Evento de origem obrigatorio.';
  end if;

  select organization_id into v_org from public.events where id = p_source_event_id;
  if v_org is null then
    raise exception 'Evento de origem invalido.';
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
    for v_coupon in
      select c.*
      from public.coupons c
      join public.coupon_event_scopes ces on ces.coupon_id = c.id
      where ces.event_id = p_source_event_id
        and c.organization_id = v_org
        and c.applies_to_tickets
    loop
      v_new_code := v_coupon.code;
      v_suffix := 1;
      while exists(select 1 from public.coupons where organization_id = v_org and code = v_new_code) loop
        v_suffix := v_suffix + 1;
        v_new_code := v_coupon.code || '-' || v_suffix;
      end loop;

      insert into public.coupons (
        organization_id,
        code,
        notes,
        discount_type,
        discount_value,
        applies_to_tickets,
        applies_to_products,
        max_uses,
        used_count,
        valid_from,
        valid_until,
        is_active
      ) values (
        v_org,
        v_new_code,
        v_coupon.notes,
        v_coupon.discount_type,
        v_coupon.discount_value,
        true,
        false,
        v_coupon.max_uses,
        0,
        v_coupon.valid_from,
        v_coupon.valid_until,
        false
      )
      on conflict (organization_id, code) do nothing
      returning id into v_new_coupon_id;

      if v_new_coupon_id is not null then
        insert into public.coupon_event_scopes (coupon_id, event_id)
        values (v_new_coupon_id, v_target_event_id);

        if p_copy_categories then
          insert into public.coupon_ticket_category_scopes (coupon_id, ticket_category_id)
          select v_new_coupon_id, tc_target.id
          from public.coupon_ticket_category_scopes cts
          join public.ticket_categories tc_source on tc_source.id = cts.ticket_category_id
          join public.ticket_categories tc_target
            on tc_target.event_id = v_target_event_id
           and tc_target.slug = tc_source.slug
          where cts.coupon_id = v_coupon.id;
        end if;
      end if;

      v_new_coupon_id := null;
    end loop;
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

commit;
