-- 030_fix_checkout_delete.sql
-- Replace only session-temp cleanup DELETE in create_multi_ticket_order_checkout.

do $$
declare
  v_fn_oid oid;
  v_def text;
  v_new text := E'if to_regclass(''pg_temp.tmp_inventory_checkout_boost'') is not null then\n    execute ''truncate table pg_temp.tmp_inventory_checkout_boost'';\nend if;';
begin
  v_fn_oid := to_regprocedure('public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)');

  if v_fn_oid is null then
    raise exception 'Funcao public.create_multi_ticket_order_checkout nao encontrada com a assinatura esperada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
  into v_def;

  if v_def !~* 'delete\s+from\s+pg_temp\.tmp_inventory_checkout_boost\s*;' then
    raise exception 'Trecho alvo nao encontrado na funcao instalada. Abortando para evitar alteracoes adicionais.';
  end if;

  v_def := regexp_replace(
    v_def,
    'delete\s+from\s+pg_temp\.tmp_inventory_checkout_boost\s*;',
    v_new,
    'i'
  );

  execute v_def;
end;
$$;

grant execute on function public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text) to authenticated;
