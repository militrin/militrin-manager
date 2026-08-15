-- 044_fix_tickets_on_conflict_order_item_id.sql
-- Corrige ON CONFLICT(order_item_id) para casar com indice unico parcial
-- e garante um indice unico completo para compatibilidade entre ambientes.

create unique index if not exists ux_tickets_order_item_id_all
  on public.tickets (order_item_id);

do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.confirm_order_item_and_issue_ticket(uuid)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid)
      into v_def_original;

    v_def_new := replace(
      v_def_original,
      'on conflict (order_item_id)',
      'on conflict (order_item_id) where order_item_id is not null'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;

do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.assign_order_item_participant(uuid, uuid)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid)
      into v_def_original;

    v_def_new := replace(
      v_def_original,
      'on conflict (order_item_id)',
      'on conflict (order_item_id) where order_item_id is not null'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;
