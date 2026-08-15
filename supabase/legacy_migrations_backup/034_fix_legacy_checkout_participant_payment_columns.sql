-- 034_fix_legacy_checkout_participant_payment_columns.sql
-- Remove payment_method/payment_status apenas do INSERT em participants.

do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_corrigida text;
begin
  v_fn_oid := to_regprocedure(
    'public.create_multi_ticket_order_checkout_legacy(
      uuid, uuid, text, integer, text, text, text, text, text, text,
      date, text, text, text, text, boolean, jsonb, integer, text, text
    )'
  );

  if v_fn_oid is null then
    raise exception 'Funcao legacy de checkout nao encontrada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
    into v_def_original;

  v_def_corrigida := regexp_replace(
    v_def_original,
    'notes\s*,\s*payment_method\s*,\s*payment_status\s*,\s*reservation_status',
    'notes,
      reservation_status',
    'is'
  );

  v_def_corrigida := regexp_replace(
    v_def_corrigida,
    'coalesce\s*\(\s*nullif\s*\(\s*trim\s*\(\s*coalesce\s*\(\s*p_notes\s*,\s*''''\s*\)\s*\)\s*,\s*''''\s*\)\s*,\s*''Anchor participante do checkout multi-ingressos''\s*\)\s*,\s*trim\s*\(\s*p_payment_method\s*\)\s*,\s*v_payment_status\s*,',
    'coalesce(
      nullif(trim(coalesce(p_notes, '''')), ''''),
      ''Anchor participante do checkout multi-ingressos''
    ),',
    'is'
  );

  if v_def_corrigida = v_def_original then
    raise exception 'Nenhuma substituicao foi realizada. A funcao nao foi alterada.';
  end if;

  if v_def_corrigida ~* 'notes\s*,\s*payment_method\s*,\s*payment_status' then
    raise exception 'As colunas de pagamento ainda permanecem no INSERT de participants.';
  end if;

  execute v_def_corrigida;
end
$$;