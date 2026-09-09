-- Gate: camiseta textual inequívoca deve gravar variant_id canônico no
-- vinculo de kit. 0 ou >1 variantes nunca escolhem silenciosamente.
-- A demanda de estoque continua em account_ticket_shirt_demand (idempotente).
-- Nao chama ensure_ticket_kit_items a partir da emissao: essa RPC exige
-- auth.uid() e quebraria confirmacao via webhook/service_role.
begin;

create or replace function public.materialize_order_item_kit_reservations()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_item public.event_kit_items%rowtype;
  v_org uuid;
  v_variant_id uuid;
  v_variant_count integer;
  v_link uuid;
begin
  if new.status in ('cancelled','expired','refunded') then return new; end if;
  if coalesce(new.item_kind,'ticket') <> 'ticket' then return new; end if;
  select organization_id into v_org from public.events where id=new.event_id;

  for v_item in select * from public.event_kit_items where event_id=new.event_id and is_active order by sort_order,created_at loop
    v_variant_id:=null; v_variant_count:=0;
    if v_item.item_type='shirt' then
      if nullif(trim(new.shirt_type),'') is null or nullif(trim(new.shirt_size),'') is null then continue; end if;
      select count(*), (array_agg(v.id order by v.id))[1] into v_variant_count, v_variant_id
      from public.event_kit_item_variants v
      where v.kit_item_id=v_item.id and v.is_active
        and lower(trim(v.name))=lower(trim(new.shirt_type))
        and upper(trim(v.value))=upper(trim(new.shirt_size));
      if v_variant_count<>1 then v_variant_id:=null; end if;
    end if;

    insert into public.participant_kit_items(order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(
      new.id,new.participant_id,new.event_id,v_org,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object(
        'shirt_type',trim(new.shirt_type),'shirt_size',upper(trim(new.shirt_size))
      ) || case when v_variant_id is not null then jsonb_build_object('variant_id',v_variant_id,'supply_mode',v_item.shirt_supply_mode) else '{}'::jsonb end
      else null end,
      v_item.quantity_per_participant,
      case when new.status='confirmed' then 'confirmed' else 'reserved' end
    )
    on conflict on constraint participant_kit_items_participant_kit_unique do nothing
    returning id into v_link;

    if v_link is null then
      select id into v_link from public.participant_kit_items where order_item_id=new.id and kit_item_id=v_item.id;
    end if;
    if v_item.item_type='shirt' and v_variant_id is not null and v_link is not null then
      update public.participant_kit_items
      set variant_data=coalesce(variant_data,'{}'::jsonb)||jsonb_build_object(
        'variant_id',v_variant_id,'shirt_type',trim(new.shirt_type),'shirt_size',upper(trim(new.shirt_size)),'supply_mode',v_item.shirt_supply_mode)
      where id=v_link and nullif(variant_data->>'variant_id','') is null;
    end if;
  end loop;
  return new;
end; $$;

create or replace function public.attach_order_item_kit_items_to_new_ticket()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_oi public.order_items%rowtype;
  v_item public.event_kit_items%rowtype;
  v_org uuid;
  v_variant_id uuid;
  v_variant_count integer;
  v_link uuid;
begin
  if new.order_item_id is null then return new; end if;
  select * into v_oi from public.order_items where id=new.order_item_id;
  if not found then raise exception 'Order item do ingresso nao encontrado.'; end if;
  select organization_id into v_org from public.events where id=new.event_id;

  for v_item in select * from public.event_kit_items where event_id=new.event_id and is_active order by sort_order,created_at loop
    v_variant_id:=null; v_variant_count:=0;
    if v_item.item_type='shirt' then
      if nullif(trim(v_oi.shirt_type),'') is null or nullif(trim(v_oi.shirt_size),'') is null then continue; end if;
      select count(*), (array_agg(v.id order by v.id))[1] into v_variant_count, v_variant_id
      from public.event_kit_item_variants v
      where v.kit_item_id=v_item.id and v.is_active
        and lower(trim(v.name))=lower(trim(v_oi.shirt_type))
        and upper(trim(v.value))=upper(trim(v_oi.shirt_size));
      if v_variant_count<>1 then v_variant_id:=null; end if;
    end if;

    insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(
      new.id,v_oi.id,v_oi.participant_id,new.event_id,v_org,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object(
        'shirt_type',trim(v_oi.shirt_type),'shirt_size',upper(trim(v_oi.shirt_size))
      ) || case when v_variant_id is not null then jsonb_build_object('variant_id',v_variant_id,'supply_mode',v_item.shirt_supply_mode) else '{}'::jsonb end
      else null end,
      v_item.quantity_per_participant,
      case when v_oi.status='confirmed' then 'confirmed' else 'reserved' end
    )
    on conflict on constraint participant_kit_items_participant_kit_unique do update
      set ticket_id=excluded.ticket_id,
          variant_data=case
            when v_variant_id is not null and nullif(public.participant_kit_items.variant_data->>'variant_id','') is null
            then coalesce(public.participant_kit_items.variant_data,'{}'::jsonb)||jsonb_build_object(
              'variant_id',v_variant_id,
              'shirt_type',trim(v_oi.shirt_type),
              'shirt_size',upper(trim(v_oi.shirt_size)),
              'supply_mode',v_item.shirt_supply_mode)
            else public.participant_kit_items.variant_data
          end
    returning id into v_link;

    if v_link is null then
      select id into v_link from public.participant_kit_items where order_item_id=v_oi.id and kit_item_id=v_item.id;
    end if;
    if v_item.item_type='shirt' and v_variant_id is not null and v_link is not null then
      perform public.account_ticket_shirt_demand(v_link);
    end if;
  end loop;

  update public.participant_kit_items pki
  set ticket_id=new.id
  where pki.ticket_id is null and pki.order_item_id=new.order_item_id;

  return new;
end; $$;

commit;
