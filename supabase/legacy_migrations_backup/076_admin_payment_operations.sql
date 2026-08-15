-- 076_admin_payment_operations.sql
-- Corrige confirmação administrativa de pagamentos não-pending (expired, cancelled).
-- Cria: admin_confirm_participant_payment (helper interno),
--        admin_update_payment_status (RPC single),
--        finalize_import_batch (RPC em lote).

begin;

-- ============================================================
-- 1. HELPER INTERNO: admin_confirm_participant_payment
-- Confirma administrativamente um pagamento para 'paid'.
-- Não exportado para authenticated — chamado pelas RPCs públicas.
-- Requisito: usuário autenticado; validações de permissão/org feitas pelo caller.
-- ============================================================

create or replace function public.admin_confirm_participant_payment(
  p_participant_id uuid,
  p_payment_id     uuid,
  p_reason         text,
  p_actor_user_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_participant   public.participants%rowtype;
  v_payment       public.payments%rowtype;
  v_order_id      uuid;
  v_ticket_id     uuid;
  v_actor_uid     uuid := coalesce(p_actor_user_id, auth.uid());
  v_actor_email   text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_uid),
    'admin'
  );
begin
  -- ── 1. Carrega participante ─────────────────────────────────────────
  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante % não encontrado.', p_participant_id;
  end if;

  -- ── 2. Carrega e trava pagamento ────────────────────────────────────
  select * into v_payment
  from public.payments
  where id = p_payment_id
    and participant_id = p_participant_id
  for update;

  if not found then
    raise exception 'Pagamento % não encontrado para o participante.', p_payment_id;
  end if;

  if v_payment.payment_status = 'paid' then
    -- Idempotente: já está pago, apenas garante ticket
    select o.id into v_order_id
    from public.orders o where o.participant_id = p_participant_id limit 1;
    if v_order_id is not null then
      v_ticket_id := public.confirm_order_and_issue_ticket(p_participant_id);
    end if;
    return jsonb_build_object(
      'success', true,
      'already_paid', true,
      'ticket_issued', v_ticket_id is not null,
      'ticket_id', v_ticket_id
    );
  end if;

  -- ── 3. Atualiza pagamento para paid ─────────────────────────────────
  update public.payments
  set payment_status = 'paid',
      paid_at        = coalesce(paid_at, now()),
      updated_at     = now()
  where id = p_payment_id;

  -- ── 4. Atualiza participante ─────────────────────────────────────────
  update public.participants
  set registration_status    = 'confirmed',
      reservation_status     = 'confirmed',
      reservation_expires_at = null,
      reservation_released_at = null,
      updated_at             = now()
  where id = p_participant_id;

  -- ── 5. Garante pedido e emite ingresso ──────────────────────────────
  -- Usa user_id do participante ou o ator administrativo como fallback.
  begin
    v_order_id := public.ensure_order_for_participant(
      p_participant_id,
      coalesce(v_participant.user_id, v_actor_uid)
    );
  exception when others then
    -- Se não for possível criar pedido, tenta apenas emitir se já existir
    select o.id into v_order_id
    from public.orders o where o.participant_id = p_participant_id limit 1;
  end;

  if v_order_id is not null then
    begin
      v_ticket_id := public.confirm_order_and_issue_ticket(p_participant_id);
    exception when others then
      -- Ticket pode já existir ou haver impedimento — não aborta a confirmação
      v_ticket_id := null;
    end;
  end if;

  -- ── 6. Auditoria ─────────────────────────────────────────────────────
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'payment_admin_confirmed',
    'payments',
    p_payment_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_uid,
      'actor_email', v_actor_email,
      'organization_id', v_participant.organization_id,
      'participant_id', p_participant_id,
      'order_id', v_order_id,
      'payment_id', p_payment_id,
      'previous_status', v_payment.payment_status,
      'new_status', 'paid',
      'reason', p_reason,
      'source', 'admin_confirm',
      'administrative_override', true,
      'ticket_issued', v_ticket_id is not null,
      'ticket_id', v_ticket_id
    )
  );

  return jsonb_build_object(
    'success', true,
    'already_paid', false,
    'ticket_issued', v_ticket_id is not null,
    'ticket_id', v_ticket_id
  );
end;
$$;

-- Não expor diretamente para authenticated
revoke all on function public.admin_confirm_participant_payment(uuid, uuid, text, uuid)
  from public, anon, authenticated;

-- ============================================================
-- 2. RPC PÚBLICA: admin_update_payment_status
-- Transição administrativa completa de status de pagamento.
-- Retorna jsonb {success, message}.
-- ============================================================

create or replace function public.admin_update_payment_status(
  p_payment_id              uuid,
  p_participant_id          uuid,
  p_expected_current_status text,
  p_new_status              text,
  p_reason                  text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_participant     public.participants%rowtype;
  v_payment         public.payments%rowtype;
  v_actor_uid       uuid := auth.uid();
  v_actor_email     text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_uid),
    'admin'
  );
  v_valid_statuses  text[] := array['pending','paid','expired','cancelled','refunded'];
  v_order_id        uuid;
  v_confirm_result  jsonb;
begin
  -- ── Validações básicas ───────────────────────────────────────────────
  if v_actor_uid is null then
    return jsonb_build_object('success', false, 'message', 'Não autenticado.');
  end if;

  if p_new_status is null or not (p_new_status = any(v_valid_statuses)) then
    return jsonb_build_object('success', false, 'message', format('Status "%s" inválido.', p_new_status));
  end if;

  if nullif(trim(p_reason), '') is null or length(trim(p_reason)) < 3 then
    return jsonb_build_object('success', false, 'message', 'Motivo obrigatório (mínimo 3 caracteres).');
  end if;

  -- ── Permissão ────────────────────────────────────────────────────────
  if p_new_status = 'refunded' then
    if not public.resolve_user_permission(v_actor_uid, 'finance.refund') then
      return jsonb_build_object('success', false, 'message', 'Sem permissão para estornar pagamentos.');
    end if;
  else
    if not (
      public.is_active_owner(v_actor_uid)
      or public.resolve_user_permission(v_actor_uid, 'finance.confirm_payment')
    ) then
      return jsonb_build_object('success', false, 'message', 'Sem permissão para alterar status de pagamento.');
    end if;
  end if;

  -- ── Carrega participante e valida organização ────────────────────────
  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Participante não encontrado.');
  end if;

  if not public.user_can_access_organization(v_actor_uid, v_participant.organization_id) then
    return jsonb_build_object('success', false, 'message', 'Sem acesso à organização deste participante.');
  end if;

  -- ── Carrega pagamento com SELECT FOR UPDATE (concorrência) ────────────
  select * into v_payment
  from public.payments
  where id = p_payment_id
    and participant_id = p_participant_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Pagamento não encontrado.');
  end if;

  -- Verificação de concorrência
  if v_payment.payment_status <> p_expected_current_status then
    return jsonb_build_object(
      'success', false,
      'message', 'O pagamento foi alterado por outro usuário. Atualize a lista e tente novamente.'
    );
  end if;

  if v_payment.payment_status = p_new_status then
    return jsonb_build_object('success', false, 'message', 'O pagamento já está com esse status.');
  end if;

  -- ── Bloqueio de regressão com uso operacional ─────────────────────────
  if p_new_status in ('cancelled', 'expired', 'pending') then
    -- Bloqueia se ticket já foi usado no check-in
    if exists (
      select 1 from public.tickets
      where participant_id = p_participant_id and status = 'used'
    ) then
      return jsonb_build_object(
        'success', false,
        'message', format('Não é possível alterar para "%s": este participante já realizou check-in.', p_new_status)
      );
    end if;

    -- Bloqueia regressão para cancelled/expired se kit entregue
    if p_new_status in ('cancelled', 'expired') then
      if exists (
        select 1 from public.participant_kit_items
        where participant_id = p_participant_id and status = 'delivered'
        limit 1
      ) then
        return jsonb_build_object(
          'success', false,
          'message', format('Não é possível alterar para "%s": itens do kit já foram entregues.', p_new_status)
        );
      end if;
    end if;
  end if;

  -- ── Execução da transição ─────────────────────────────────────────────
  if p_new_status = 'paid' then
    -- Usa helper interno que bypassa simulate_payment_paid
    v_confirm_result := public.admin_confirm_participant_payment(
      p_participant_id, p_payment_id, p_reason, v_actor_uid
    );
    if not (v_confirm_result ->> 'success')::boolean then
      return v_confirm_result;
    end if;

  else
    -- Atualização direta para outros status
    update public.payments
    set payment_status = p_new_status,
        updated_at     = now()
    where id = p_payment_id;

    -- Sincroniza participant.registration_status
    update public.participants
    set registration_status = case p_new_status
          when 'pending'    then 'pending'
          when 'expired'    then 'pending'
          when 'cancelled'  then 'cancelled'
          when 'refunded'   then 'pending'
          else registration_status
        end,
        updated_at = now()
    where id = p_participant_id;

    -- Sincroniza order.status (sem payment_status — orders só tem status)
    select o.id into v_order_id
    from public.orders o where o.participant_id = p_participant_id limit 1;

    if v_order_id is not null then
      update public.orders
      set status = case p_new_status
            when 'pending'    then 'pending'
            when 'expired'    then 'expired'
            when 'cancelled'  then 'cancelled'
            when 'refunded'   then 'refunded'
            else status
          end,
          cancelled_at = case
            when p_new_status in ('cancelled', 'refunded') and cancelled_at is null then now()
            else cancelled_at
          end,
          updated_at = now()
      where id = v_order_id;
    end if;

    -- Auditoria
    insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
    values (
      'payment_status_changed',
      'payments',
      p_payment_id,
      v_participant.event_id,
      jsonb_build_object(
        'actor_user_id', v_actor_uid,
        'actor_email', v_actor_email,
        'organization_id', v_participant.organization_id,
        'participant_id', p_participant_id,
        'order_id', v_order_id,
        'payment_id', p_payment_id,
        'previous_status', v_payment.payment_status,
        'new_status', p_new_status,
        'reason', trim(p_reason),
        'source', 'participants_admin',
        'administrative_override', true
      )
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'message', format('Status alterado para "%s" com sucesso.', p_new_status)
  );
end;
$$;

revoke all on function public.admin_update_payment_status(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_update_payment_status(uuid, uuid, text, text, text)
  to authenticated;

-- ============================================================
-- 3. RPC PÚBLICA: finalize_import_batch
-- Confirma pagamentos em lote para uma importação concluída.
-- p_payment_mode: 'pending' | 'confirm_all'
-- ============================================================

create or replace function public.finalize_import_batch(
  p_import_batch_id uuid,
  p_payment_mode    text,
  p_reason          text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_batch        record;
  v_event        public.events%rowtype;
  v_actor_uid    uuid := auth.uid();
  v_actor_email  text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_uid),
    'admin'
  );
  v_reason       text := coalesce(
    nullif(trim(p_reason), ''),
    format('Pagamento confirmado na importação %s', p_import_batch_id)
  );
  v_confirmed    integer := 0;
  v_pending      integer := 0;
  v_skipped      integer := 0;
  v_failed       integer := 0;
  v_row          record;
  v_payment      public.payments%rowtype;
  v_result       jsonb;
begin
  -- ── Validações básicas ───────────────────────────────────────────────
  if v_actor_uid is null then
    return jsonb_build_object('success', false, 'message', 'Não autenticado.');
  end if;

  if p_payment_mode not in ('pending', 'confirm_all') then
    return jsonb_build_object('success', false, 'message', format('Modo "%s" inválido.', p_payment_mode));
  end if;

  if p_payment_mode = 'confirm_all' then
    if not (
      public.is_active_owner(v_actor_uid)
      or public.resolve_user_permission(v_actor_uid, 'finance.confirm_payment')
    ) then
      return jsonb_build_object('success', false, 'message', 'Sem permissão para confirmar pagamentos em lote.');
    end if;
  end if;

  -- ── Valida lote ──────────────────────────────────────────────────────
  select * into v_batch
  from public.import_batches
  where id = p_import_batch_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Importação não encontrada.');
  end if;

  if v_batch.import_type <> 'current_event_registrations' then
    return jsonb_build_object('success', false, 'message', 'finalize_import_batch aplicável somente a importações de inscritos.');
  end if;

  -- Valida acesso à organização do evento
  select * into v_event
  from public.events
  where id = v_batch.event_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Evento não encontrado.');
  end if;

  if not public.user_can_access_organization(v_actor_uid, v_event.organization_id) then
    return jsonb_build_object('success', false, 'message', 'Sem acesso à organização deste evento.');
  end if;

  -- ── Modo 'pending': nada a fazer nos pagamentos ───────────────────────
  if p_payment_mode = 'pending' then
    return jsonb_build_object(
      'success', true,
      'payment_mode', 'pending',
      'confirmed', 0,
      'pending', 0,
      'skipped', 0,
      'failed', 0,
      'message', 'Importação mantida com pagamentos pendentes.'
    );
  end if;

  -- ── Modo 'confirm_all': confirma cada participante do lote ────────────
  for v_row in
    select distinct ibr.matched_participant_id as participant_id
    from public.import_batch_rows ibr
    where ibr.import_batch_id = p_import_batch_id
      and ibr.matched_participant_id is not null
      and ibr.resolution in ('create_new', 'link_existing')
      and ibr.status = 'imported'
  loop
    -- Pega o pagamento mais recente do participante
    select * into v_payment
    from public.payments
    where participant_id = v_row.participant_id
      and event_id = v_batch.event_id
    order by created_at desc
    limit 1;

    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_payment.payment_status = 'paid' then
      -- Já pago: apenas garante ticket
      begin
        perform public.confirm_order_and_issue_ticket(v_row.participant_id);
        v_confirmed := v_confirmed + 1;
      exception when others then
        v_confirmed := v_confirmed + 1; -- conta como confirmado mesmo se ticket existia
      end;
      continue;
    end if;

    if v_payment.payment_status in ('refunded') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Confirma via helper interno
    begin
      v_result := public.admin_confirm_participant_payment(
        v_row.participant_id,
        v_payment.id,
        v_reason,
        v_actor_uid
      );

      if (v_result ->> 'success')::boolean then
        v_confirmed := v_confirmed + 1;
      else
        v_failed := v_failed + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  -- ── Auditoria do lote ─────────────────────────────────────────────────
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'import_batch_payments_confirmed',
    'import_batches',
    p_import_batch_id,
    v_batch.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_uid,
      'actor_email', v_actor_email,
      'organization_id', v_event.organization_id,
      'event_id', v_batch.event_id,
      'import_batch_id', p_import_batch_id,
      'payment_mode', p_payment_mode,
      'confirmed_count', v_confirmed,
      'pending_count', v_pending,
      'skipped_count', v_skipped,
      'failed_count', v_failed,
      'reason', v_reason
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_mode', p_payment_mode,
    'confirmed', v_confirmed,
    'pending', v_pending,
    'skipped', v_skipped,
    'failed', v_failed,
    'message', format(
      'Concluído: %s confirmados, %s ignorados, %s falhas.',
      v_confirmed, v_skipped, v_failed
    )
  );
end;
$$;

revoke all on function public.finalize_import_batch(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_import_batch(uuid, text, text)
  to authenticated;

commit;
