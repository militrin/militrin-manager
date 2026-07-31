-- 041_fix_remaining_order_id_ambiguity.sql
-- Corrige referencias ambiguas de order_id usando substituicao por regex
-- para tolerar variacoes de formatacao na funcao instalada.

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

    -- Evita ambiguidade entre coluna order_id e variavel de retorno order_id.
    v_def_new := regexp_replace(
      v_def_new,
      'update\s+public\.order_items\s+set([\s\S]*?)where\s+order_id\s*=\s*v_order_id\s*;',
      E'update public.order_items oi\n  set\\1where oi.order_id = v_order_id;',
      'i'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end loop;
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
    return;
  end if;

  select pg_get_functiondef(v_fn_oid)
    into v_def_original;

  v_def_new := v_def_original;

  -- Qualifica colunas da tabela tickets para evitar conflito com parametros/variaveis.
  v_def_new := regexp_replace(
    v_def_new,
    'update\s+public\.tickets\s+set([\s\S]*?)where\s+order_id\s*=\s*v_order_id\s+and\s+participant_id\s*=\s*p_participant_id\s+and\s+order_item_id\s+is\s+null\s*;',
    E'update public.tickets t\n  set\\1where t.order_id = v_order_id\n    and t.participant_id = p_participant_id\n    and t.order_item_id is null;',
    'i'
  );

  if v_def_new <> v_def_original then
    execute v_def_new;
  end if;
end
$$;
