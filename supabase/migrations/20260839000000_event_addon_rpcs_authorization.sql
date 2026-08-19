-- Segundo vetor encontrado na auditoria de RLS (20260838000000): as RPCs
-- SECURITY DEFINER que escrevem nas 6 tabelas de configuracao de
-- evento/checkout (event_addons_config, event_addons_model,
-- event_addon_options, event_batch_addon_options,
-- registration_batch_addons, event_payment_methods) nao faziam NENHUMA
-- checagem de auth.uid(), permissao ou organizacao no corpo -- ao contrario
-- das RPCs irmas do mesmo arquivo (upsert_event_attraction,
-- delete_event_attraction, upsert_event_schedule_item) que corretamente
-- seguem o padrao "auth.uid() obrigatorio + current_user_has_permission
-- ('events.edit') + organizacao resolvida a partir do proprio evento (nunca
-- de um organization_id enviado pelo cliente) + user_can_access
-- _organization". Como essas funcoes rodam OWNER TO postgres e nenhuma
-- tabela do schema usa FORCE ROW LEVEL SECURITY, a RLS habilitada na
-- migration anterior NAO as bloqueia -- o fix tem que ser dentro da propria
-- funcao. Replicado aqui exatamente o mesmo padrao das RPCs irmas, sem
-- inventar modelo novo.
--
-- upsert_event_addons_model tambem escreve numa das 6 tabelas (
-- event_addons_model) com o mesmo problema -- corrigida junto por ser a
-- mesma familia de RPC, mesmo padrao de exploracao, mesmo fix.
--
-- upsert_registration_batch_addons tinha, alem da falta de checagem
-- interna, EXECUTE concedido a "PUBLIC" e a "anon" explicitamente (unico
-- caso do lote com grant a anon) -- nenhum consumidor legitimo anonimo foi
-- encontrado em src/ (o unico call site e upsertBatchAddonsConfigAction em
-- src/app/eventos/actions.ts, dentro do painel administrativo autenticado)
-- -- revogado abaixo.
begin;

create or replace function public.upsert_event_addons_config(
  p_event_id uuid, p_apply_to_all_batches boolean, p_kit_enabled boolean,
  p_custom_cup_enabled boolean, p_gifts_enabled boolean
) returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  insert into public.event_addons_config (
    event_id, apply_to_all_batches, kit_enabled, custom_cup_enabled, gifts_enabled
  ) values (
    p_event_id, coalesce(p_apply_to_all_batches, true), coalesce(p_kit_enabled, false),
    coalesce(p_custom_cup_enabled, false), coalesce(p_gifts_enabled, false)
  )
  on conflict (event_id) do update set
    apply_to_all_batches = excluded.apply_to_all_batches,
    kit_enabled = excluded.kit_enabled,
    custom_cup_enabled = excluded.custom_cup_enabled,
    gifts_enabled = excluded.gifts_enabled,
    updated_at = now();

  if coalesce(p_apply_to_all_batches, true) = true then
    delete from public.registration_batch_addons where event_id = p_event_id;
  end if;
end;
$$;

create or replace function public.upsert_event_addons_model(
  p_event_id uuid, p_apply_to_all_batches boolean
) returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  insert into public.event_addons_model (event_id, apply_to_all_batches)
  values (p_event_id, coalesce(p_apply_to_all_batches, true))
  on conflict (event_id) do update set
    apply_to_all_batches = excluded.apply_to_all_batches,
    updated_at = now();
end;
$$;

create or replace function public.upsert_event_addon_option(
  p_event_id uuid, p_name text, p_description text, p_sort_order integer,
  p_is_active boolean, p_id uuid default null::uuid
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_id uuid;
  v_org uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do adicional obrigatorio.';
  end if;

  if p_id is null then
    insert into public.event_addon_options (
      event_id, name, description, sort_order, is_active
    ) values (
      p_event_id, trim(p_name), nullif(trim(coalesce(p_description, '')), ''),
      coalesce(p_sort_order, 0), coalesce(p_is_active, true)
    )
    returning id into v_id;
  else
    update public.event_addon_options
       set name = trim(p_name),
           description = nullif(trim(coalesce(p_description, '')), ''),
           sort_order = coalesce(p_sort_order, 0),
           is_active = coalesce(p_is_active, true),
           updated_at = now()
     where id = p_id
       and event_id = p_event_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Adicional nao encontrado para este evento.';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.delete_event_addon_option(
  p_event_id uuid, p_option_id uuid
) returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  if p_event_id is null or p_option_id is null then
    raise exception 'Evento e adicional obrigatorios.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  delete from public.event_addon_options
  where id = p_option_id
    and event_id = p_event_id;
end;
$$;

create or replace function public.upsert_event_batch_addon_option(
  p_event_id uuid, p_batch_id uuid, p_option_id uuid, p_enabled boolean
) returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  if p_event_id is null or p_batch_id is null or p_option_id is null then
    raise exception 'Evento, lote e adicional obrigatorios.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  if not exists (
    select 1
    from public.registration_batches b
    where b.id = p_batch_id
      and b.event_id = p_event_id
  ) then
    raise exception 'Lote nao pertence ao evento informado.';
  end if;

  if not exists (
    select 1
    from public.event_addon_options o
    where o.id = p_option_id
      and o.event_id = p_event_id
  ) then
    raise exception 'Adicional nao pertence ao evento informado.';
  end if;

  insert into public.event_batch_addon_options (
    event_id, batch_id, option_id, enabled
  ) values (
    p_event_id, p_batch_id, p_option_id, coalesce(p_enabled, true)
  )
  on conflict (batch_id, option_id) do update set
    enabled = excluded.enabled,
    updated_at = now();
end;
$$;

create or replace function public.upsert_registration_batch_addons(
  p_event_id uuid, p_batch_id uuid, p_kit_enabled boolean,
  p_custom_cup_enabled boolean, p_gifts_enabled boolean
) returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  if p_event_id is null or p_batch_id is null then
    raise exception 'Evento e lote obrigatorios.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  if not exists (
    select 1
    from public.registration_batches b
    where b.id = p_batch_id
      and b.event_id = p_event_id
  ) then
    raise exception 'Lote nao pertence ao evento informado.';
  end if;

  insert into public.registration_batch_addons (
    event_id, batch_id, kit_enabled, custom_cup_enabled, gifts_enabled
  ) values (
    p_event_id, p_batch_id, coalesce(p_kit_enabled, false),
    coalesce(p_custom_cup_enabled, false), coalesce(p_gifts_enabled, false)
  )
  on conflict (batch_id) do update set
    event_id = excluded.event_id,
    kit_enabled = excluded.kit_enabled,
    custom_cup_enabled = excluded.custom_cup_enabled,
    gifts_enabled = excluded.gifts_enabled,
    updated_at = now();
end;
$$;

create or replace function public.upsert_event_payment_methods(
  p_event_id uuid, p_pix_enabled boolean default true,
  p_credit_card_single_enabled boolean default true,
  p_credit_card_installments_enabled boolean default true
) returns void language plpgsql security definer set search_path to 'public' as $$
declare v_org uuid;
begin
  if p_event_id is null then
    raise exception 'Evento invalido.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  if not coalesce(p_pix_enabled, false)
     and not coalesce(p_credit_card_single_enabled, false)
     and not coalesce(p_credit_card_installments_enabled, false) then
    raise exception 'Selecione pelo menos uma forma de pagamento.';
  end if;

  insert into public.event_payment_methods (
    event_id, pix_enabled, credit_card_single_enabled, credit_card_installments_enabled,
    created_at, updated_at
  )
  values (
    p_event_id, coalesce(p_pix_enabled, true), coalesce(p_credit_card_single_enabled, true),
    coalesce(p_credit_card_installments_enabled, true), now(), now()
  )
  on conflict (event_id) do update set
    pix_enabled = excluded.pix_enabled,
    credit_card_single_enabled = excluded.credit_card_single_enabled,
    credit_card_installments_enabled = excluded.credit_card_installments_enabled,
    updated_at = now();
end;
$$;

create or replace function public.upsert_event_highlight(
  p_event_id uuid, p_sort_order integer, p_is_active boolean default true
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_id uuid;
  v_org uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  insert into public.event_highlights (event_id, sort_order, is_active)
  values (p_event_id, coalesce(p_sort_order, 0), coalesce(p_is_active, true))
  on conflict (event_id) do update
    set sort_order = excluded.sort_order,
        is_active = excluded.is_active,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.remove_event_highlight(
  p_event_id uuid
) returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  delete from public.event_highlights
  where event_id = p_event_id;
end;
$$;

-- upsert_registration_batch_addons e a unica RPC deste lote com EXECUTE
-- concedido a PUBLIC/anon -- sem consumidor legitimo anonimo em src/.
-- Revogado; authenticated/service_role preservados (mesmo padrao das
-- outras 8 RPCs deste arquivo, que nunca tiveram grant a anon).
revoke execute on function public.upsert_registration_batch_addons(uuid, uuid, boolean, boolean, boolean) from public;
revoke execute on function public.upsert_registration_batch_addons(uuid, uuid, boolean, boolean, boolean) from anon;

commit;
