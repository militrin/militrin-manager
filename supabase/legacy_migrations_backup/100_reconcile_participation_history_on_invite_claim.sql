-- 100_reconcile_participation_history_on_invite_claim.sql
-- Reconcilia historicos duplicados do mesmo participant/event antes do claim.

begin;

create or replace function public.claim_participant_account_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_auth_email text;
  v_inv public.participant_account_invites%rowtype;
  v_p public.participants%rowtype;
  v_canonical_history_id uuid;
  v_canonical_participant_id uuid;
  v_duplicate_history_ids uuid[]:='{}'::uuid[];
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;

  select lower(trim(email)) into v_auth_email from auth.users where id=v_actor;
  select * into v_inv
  from public.participant_account_invites
  where id=p_invite_id
  for update;

  if not found then raise exception 'Convite invalido ou expirado.'; end if;

  -- O claim pode ser repetido depois que uma etapa posterior do primeiro acesso
  -- falhar. A repeticao nunca reabre nem transfere um convite ja reivindicado.
  if v_inv.status='claimed' then
    if v_inv.claimed_user_id is distinct from v_actor then
      raise exception 'Convite ja reivindicado por outra conta.';
    end if;
    select * into v_p from public.participants where id=v_inv.participant_id for update;
    if not found or v_p.user_id is distinct from v_actor then
      raise exception 'Estado inconsistente do convite reivindicado.';
    end if;
    return v_p.id;
  end if;

  if v_inv.status<>'pending' or v_inv.expires_at<=now() then
    raise exception 'Convite invalido ou expirado.';
  end if;
  if v_inv.auth_user_id is distinct from v_actor then
    raise exception 'O convite nao esta correlacionado a esta conta.';
  end if;
  if v_auth_email is distinct from lower(trim(v_inv.email)) then
    raise exception 'O convite nao pertence a esta conta.';
  end if;

  select * into v_p
  from public.participants
  where id=v_inv.participant_id
  for update;

  if not found or v_p.event_id is distinct from v_inv.event_id then
    raise exception 'Cadastro invalido para o evento do convite.';
  end if;
  if v_p.user_id is not null and v_p.user_id<>v_actor then
    raise exception 'Cadastro ja vinculado a outra conta.';
  end if;

  -- Serializa todos os candidatos capazes de participar da reconciliacao.
  perform ph.id
  from public.participation_history ph
  where ph.event_id=v_inv.event_id
    and (ph.user_id=v_actor or ph.participant_id=v_p.id)
  order by ph.created_at,ph.id
  for update;

  -- Um history explicitamente ligado a outro user nunca e apropriado pelo
  -- convite, ainda que compartilhe participant_id, e-mail ou CPF.
  if exists(
    select 1 from public.participation_history ph
    where ph.event_id=v_inv.event_id
      and ph.participant_id=v_p.id
      and ph.user_id is not null
      and ph.user_id<>v_actor
  ) then
    raise exception 'Historico do cadastro vinculado a outra conta; revisao manual obrigatoria.';
  end if;

  -- Se o ator ja possui um confirmado no evento, ele e o unico candidato
  -- canonico. So pode ser reconciliado quando nao pertence a outro participant.
  select ph.id,ph.participant_id
  into v_canonical_history_id,v_canonical_participant_id
  from public.participation_history ph
  where ph.user_id=v_actor
    and ph.event_id=v_inv.event_id
    and ph.status='confirmed'
  order by ph.created_at,ph.id
  limit 1;

  if v_canonical_history_id is not null
    and v_canonical_participant_id is not null
    and v_canonical_participant_id<>v_p.id then
    raise exception 'A conta ja possui participacao confirmada de outro cadastro neste evento.';
  end if;

  -- Sem confirmado previo do ator, preserva como canonico o primeiro history
  -- confirmado criado para o participant. O criterio e estavel entre retries.
  if v_canonical_history_id is null then
    select ph.id into v_canonical_history_id
    from public.participation_history ph
    where ph.participant_id=v_p.id
      and ph.event_id=v_inv.event_id
      and ph.status='confirmed'
    order by ph.created_at,ph.id
    limit 1;
  end if;

  if v_canonical_history_id is not null then
    with demoted as (
      update public.participation_history ph
      set status='duplicate',updated_at=now()
      where ph.participant_id=v_p.id
        and ph.event_id=v_inv.event_id
        and ph.status='confirmed'
        and ph.id<>v_canonical_history_id
      returning ph.id
    )
    select coalesce(array_agg(id order by id),'{}'::uuid[])
    into v_duplicate_history_ids
    from demoted;

    update public.participation_history
    set participant_id=v_p.id,updated_at=now()
    where id=v_canonical_history_id
      and participant_id is null;
  end if;

  -- Depois da desduplicacao, no maximo um row confirmed recebe o par
  -- (v_actor,event_id); os demais dados permanecem preservados como duplicate.
  update public.participation_history ph
  set user_id=v_actor,updated_at=now()
  where ph.participant_id=v_p.id
    and ph.event_id=v_inv.event_id
    and (ph.user_id is null or ph.user_id=v_actor);

  update public.participants
  set user_id=v_actor,updated_at=now()
  where id=v_p.id;

  update public.participant_account_invites
  set status='claimed',claimed_user_id=v_actor,claimed_at=now(),updated_at=now()
  where id=v_inv.id;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values(
    'participant_account_invite_claimed',
    'participants',
    v_p.id,
    v_p.event_id,
    jsonb_build_object(
      'invite_id',v_inv.id,
      'user_id',v_actor,
      'canonical_history_id',v_canonical_history_id,
      'duplicate_history_ids',to_jsonb(v_duplicate_history_ids)
    )
  );

  return v_p.id;
end;
$$;

revoke all on function public.claim_participant_account_invite(uuid) from public,anon,authenticated;
grant execute on function public.claim_participant_account_invite(uuid) to authenticated;

commit;
