-- 040_fix_order_id_ambiguity_in_functions.sql
-- Corrige referencias ambiguas de order_id em funcoes PL/pgSQL.

do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
  v_old_block text;
  v_new_block text;
begin
  v_fn_oid := to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)');

  if v_fn_oid is null then
    raise exception 'Funcao public.create_multi_ticket_order_checkout_legacy nao encontrada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
    into v_def_original;

  v_def_new := v_def_original;

  v_old_block := $old$
  update public.order_items
  set status = case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end,
      reservation_expires_at = v_reservation_expires_at,
      updated_at = now()
  where order_id = v_order_id;
$old$;

  v_new_block := $new$
  update public.order_items oi
  set status = case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end,
      reservation_expires_at = v_reservation_expires_at,
      updated_at = now()
  where oi.order_id = v_order_id;
$new$;

  v_def_new := replace(v_def_new, v_old_block, v_new_block);

  if v_def_new <> v_def_original then
    execute v_def_new;
  end if;
end
$$;

do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.ensure_order_for_participant(uuid, uuid)');

  if v_fn_oid is null then
    raise exception 'Funcao public.ensure_order_for_participant(uuid, uuid) nao encontrada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
    into v_def_original;

  v_def_new := replace(
    v_def_original,
    'update public.tickets
  set
    order_item_id = v_order_item_id,
    ownership_status = ''assigned''
  where order_id = v_order_id
    and participant_id = p_participant_id
    and order_item_id is null;',
    'update public.tickets t
  set
    order_item_id = v_order_item_id,
    ownership_status = ''assigned''
  where t.order_id = v_order_id
    and t.participant_id = p_participant_id
    and t.order_item_id is null;'
  );

  if v_def_new <> v_def_original then
    execute v_def_new;
  end if;
end
$$;
