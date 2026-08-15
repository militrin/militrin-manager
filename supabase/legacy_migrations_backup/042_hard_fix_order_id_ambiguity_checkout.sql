-- 042_hard_fix_order_id_ambiguity_checkout.sql
-- Correcao abrangente para ambiguidades de order_id nas funcoes de checkout.

-- 1) create_multi_ticket_order_checkout_legacy
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid) into v_def_original;
    v_def_new := v_def_original;

    v_def_new := regexp_replace(
      v_def_new,
      'update\s+public\.order_items\s+set',
      E'update public.order_items oi\n  set',
      'i'
    );

    v_def_new := regexp_replace(
      v_def_new,
      'where\s+order_id\s*=\s*v_order_id\s*;',
      'where oi.order_id = v_order_id;',
      'i'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;

-- 2) create_multi_ticket_order_checkout (wrapper pode existir em alguns ambientes)
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid) into v_def_original;
    v_def_new := v_def_original;

    v_def_new := regexp_replace(
      v_def_new,
      'update\s+public\.order_items\s+set',
      E'update public.order_items oi\n  set',
      'i'
    );

    v_def_new := regexp_replace(
      v_def_new,
      'where\s+order_id\s*=\s*v_order_id\s*;',
      'where oi.order_id = v_order_id;',
      'i'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;

-- 3) start_order_payment_pix
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.start_order_payment_pix(uuid, text, text, text, timestamptz)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid) into v_def_original;
    v_def_new := v_def_original;

    v_def_new := regexp_replace(
      v_def_new,
      'from\s+public\.payments\s+\n\s*where\s+order_id\s*=\s*p_order_id',
      E'from public.payments\n  where public.payments.order_id = p_order_id',
      'i'
    );

    v_def_new := regexp_replace(
      v_def_new,
      'update\s+public\.order_items\s+\n\s*set',
      E'update public.order_items oi\n  set',
      'i'
    );

    v_def_new := regexp_replace(
      v_def_new,
      'where\s+order_id\s*=\s*p_order_id',
      'where oi.order_id = p_order_id',
      'i'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;

-- 4) confirm_order_payment_and_issue_tickets
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.confirm_order_payment_and_issue_tickets(uuid)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid) into v_def_original;
    v_def_new := v_def_original;

    v_def_new := regexp_replace(
      v_def_new,
      'from\s+public\.payments\s+\n\s*where\s+order_id\s*=\s*p_order_id',
      E'from public.payments\n  where public.payments.order_id = p_order_id',
      'i'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;

-- 5) simulate_order_payment_paid
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.simulate_order_payment_paid(uuid, text)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid) into v_def_original;
    v_def_new := v_def_original;

    v_def_new := regexp_replace(
      v_def_new,
      'from\s+public\.payments\s+\n\s*where\s+order_id\s*=\s*p_order_id',
      E'from public.payments\n  where public.payments.order_id = p_order_id',
      'i'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;

-- 6) ensure_order_for_participant
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
begin
  v_fn_oid := to_regprocedure('public.ensure_order_for_participant(uuid, uuid)');
  if v_fn_oid is not null then
    select pg_get_functiondef(v_fn_oid) into v_def_original;
    v_def_new := v_def_original;

    v_def_new := regexp_replace(
      v_def_new,
      'update\s+public\.tickets\s+\n\s*set',
      E'update public.tickets t\n  set',
      'i'
    );

    v_def_new := regexp_replace(
      v_def_new,
      'where\s+order_id\s*=\s*v_order_id',
      'where t.order_id = v_order_id',
      'i'
    );

    v_def_new := regexp_replace(
      v_def_new,
      'and\s+participant_id\s*=\s*p_participant_id',
      'and t.participant_id = p_participant_id',
      'i'
    );

    v_def_new := regexp_replace(
      v_def_new,
      'and\s+order_item_id\s+is\s+null',
      'and t.order_item_id is null',
      'i'
    );

    if v_def_new <> v_def_original then
      execute v_def_new;
    end if;
  end if;
end
$$;
