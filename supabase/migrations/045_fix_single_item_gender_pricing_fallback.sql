-- 045_fix_single_item_gender_pricing_fallback.sql
-- Remove fallback implicito para preco masculino no checkout e valida genero de preco.

do $$
declare
  v_sig text;
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  for v_sig in
    select unnest(array[
      'public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)',
      'public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)'
    ]::text[])
  loop
    v_fn_oid := to_regprocedure(v_sig);
    if v_fn_oid is null then
      continue;
    end if;

    select pg_get_functiondef(v_fn_oid)
      into v_def_original;

    v_def_new := v_def_original;

    v_def_new := replace(
      v_def_new,
      '  select * into v_pricing
  from public.get_registration_pricing_preview(
    coalesce(nullif(lower(trim(coalesce(p_gender, ''''))), ''''), ''male''),',
      '  v_item_pricing_gender := lower(trim(coalesce(p_gender, p_buyer_gender, '''')));

  if v_item_pricing_gender in (''masculino'', ''m'') then
    v_item_pricing_gender := ''male'';
  elsif v_item_pricing_gender in (''feminino'', ''f'') then
    v_item_pricing_gender := ''female'';
  end if;

  if v_item_pricing_gender not in (''male'', ''female'') then
    raise exception ''Genero invalido para calculo de preco. Use Masculino ou Feminino.'';
  end if;

  select * into v_pricing
  from public.get_registration_pricing_preview(
    v_item_pricing_gender,'
    );

    v_def_new := replace(
      v_def_new,
      'v_item_pricing_gender := lower(trim(coalesce(v_item_payload ->> ''pricing_gender'', v_item_payload ->> ''price_gender'', p_gender, p_buyer_gender, ''male'')));',
      'v_item_pricing_gender := lower(trim(coalesce(v_item_payload ->> ''pricing_gender'', v_item_payload ->> ''price_gender'', p_gender, p_buyer_gender, '''')));'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end loop;
end
$$;
