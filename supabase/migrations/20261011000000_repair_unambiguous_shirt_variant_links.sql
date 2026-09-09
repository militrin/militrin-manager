-- Reparo pontual: grava variant_id canônico em participant_kit_items
-- quando Tipo+Tamanho textual bate com EXATAMENTE 1 variante ativa.
-- Nao cria produto/variante, nao altera texto historico, quantidade,
-- titular, pedido, pagamento nem status. A demanda de estoque e
-- recontada pelo trigger trg_reconcile_participant_shirt_demand
-- (projecao completa) -- nunca incrementa reserved a parte.
begin;

create or replace function public.repair_unambiguous_shirt_variant_links(
  p_event_id uuid,
  p_apply boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_resolvable integer := 0;
  v_missing integer := 0;
  v_ambiguous integer := 0;
  v_unspecified integer := 0;
  v_applied integer := 0;
  v_row record;
  v_variant_id uuid;
  v_variant_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;
  if not (
    public.current_user_has_permission('inventory.change_participant_shirt')
    or public.current_user_has_permission('integrity.view')
  ) then
    raise exception 'Sem permissao para auditar vinculos de camiseta.';
  end if;
  if p_apply and not public.current_user_has_permission('inventory.change_participant_shirt') then
    raise exception 'Sem permissao para materializar variant_id.';
  end if;

  for v_row in
    select
      pki.id as link_id,
      pki.kit_item_id,
      coalesce(nullif(trim(pki.variant_data->>'shirt_type'), ''), nullif(trim(oi.shirt_type), '')) as shirt_type,
      coalesce(nullif(trim(pki.variant_data->>'shirt_size'), ''), nullif(trim(oi.shirt_size), '')) as shirt_size,
      nullif(pki.variant_data->>'variant_id', '') as current_variant_id
    from public.participant_kit_items pki
    join public.event_kit_items eki on eki.id = pki.kit_item_id
    join public.tickets t on t.id = pki.ticket_id
    left join public.order_items oi on oi.id = pki.order_item_id
    where pki.event_id = p_event_id
      and eki.item_type = 'shirt'
      and eki.is_active
      and pki.status <> 'cancelled'
      and t.status <> 'cancelled'
      and coalesce(pki.variant_data->>'variant_id', '') = ''
  loop
    if v_row.shirt_type is null or v_row.shirt_size is null then
      v_unspecified := v_unspecified + 1;
      continue;
    end if;
    select count(*), (array_agg(v.id order by v.id))[1]
      into v_variant_count, v_variant_id
    from public.event_kit_item_variants v
    where v.kit_item_id = v_row.kit_item_id
      and v.is_active
      and lower(trim(v.name)) = lower(trim(v_row.shirt_type))
      and upper(trim(v.value)) = upper(trim(v_row.shirt_size));
    if v_variant_count = 1 then
      v_resolvable := v_resolvable + 1;
      if p_apply then
        update public.participant_kit_items
        set variant_data = coalesce(variant_data, '{}'::jsonb) || jsonb_build_object('variant_id', v_variant_id)
        where id = v_row.link_id
          and coalesce(variant_data->>'variant_id', '') = '';
        v_applied := v_applied + 1;
      end if;
    elsif v_variant_count = 0 then
      v_missing := v_missing + 1;
    else
      v_ambiguous := v_ambiguous + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'event_id', p_event_id,
    'applied', p_apply,
    'resolvable', v_resolvable,
    'missing', v_missing,
    'ambiguous', v_ambiguous,
    'unspecified', v_unspecified,
    'updated', v_applied
  );
end;
$$;

revoke all on function public.repair_unambiguous_shirt_variant_links(uuid, boolean) from public, anon;
grant execute on function public.repair_unambiguous_shirt_variant_links(uuid, boolean) to authenticated, service_role;

commit;
