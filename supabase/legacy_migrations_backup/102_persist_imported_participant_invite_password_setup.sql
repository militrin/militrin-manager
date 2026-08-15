-- 102_persist_imported_participant_invite_password_setup.sql
-- Torna persistente a exigencia de senha no onboarding de participantes importados.

begin;

alter table public.participant_account_invites
  add column if not exists requires_password_setup boolean not null default false,
  add column if not exists password_setup_completed_at timestamptz;

alter table public.participant_account_invites
  drop constraint if exists participant_account_invites_password_setup_state_check;
alter table public.participant_account_invites
  add constraint participant_account_invites_password_setup_state_check check(
    password_setup_completed_at is null or requires_password_setup
  );

-- Remove somente a classificacao legada baseada na senha Auth. O restante da
-- funcao 099 e preservado byte a byte pela substituicao do bloco conhecido.
do $migration$
declare
  v_signature regprocedure:=to_regprocedure(
    'public.check_participant_account_invite_eligibility(uuid)'
  );
  v_definition text;
  v_normalized text;
  v_expected text:=$expected$  if nullif(v_auth_user.encrypted_password,'') is null then
    return query select true,'resend_invite_password_required','Convite pode ser reenviado para concluir o primeiro acesso.',v_email;
  else
    return query select true,'resend_invite_existing_account','Conta existente validada pelo convite; enviar acesso seguro para reivindicar o cadastro.',v_email;
  end if;$expected$;
  v_replacement text:=$replacement$  if exists(
    select 1 from public.participation_history ph
    where ph.participant_id=v_p.id
      and ph.event_id=v_p.event_id
      and ph.source='import'
  ) then
    return query select true,'resend_invite_password_required','Convite importado pode ser reenviado para concluir o primeiro acesso.',v_email;
  else
    return query select true,'resend_invite_existing_account','Conta existente validada pelo convite; enviar acesso seguro para reivindicar o cadastro.',v_email;
  end if;$replacement$;
begin
  if v_signature is null then
    raise exception 'Funcao check_participant_account_invite_eligibility(uuid) ausente.';
  end if;
  select pg_get_functiondef(v_signature) into v_definition;
  v_normalized:=regexp_replace(lower(v_definition),'\s+','','g');

  if position('current_user_has_permission(''participants.edit_basic'')' in v_normalized)=0
    or position('user_can_access_organization(v_actor,v_p.organization_id)' in v_normalized)=0
    or position('lower(trim(coalesce(au.email,'''')))=v_email' in v_normalized)=0
    or position('participant_invite_id''=pai.id::text' in v_normalized)=0
    or position('v_conflicting_participants>0' in v_normalized)=0
    or position('v_profile_cpf<>regexp_replace(coalesce(v_p.cpf,''''),''\d'','''',''g'')' in v_normalized)=0
    or position('''already_linked''' in v_normalized)=0
    or position('''account_conflict''' in v_normalized)=0 then
    raise exception 'Definicao ativa diverge das garantias esperadas da migration 099.';
  end if;

  -- Reaplicacao segura: classificacao importada ja instalada e sem leitura da senha.
  if position('ph.source=''import''' in v_normalized)>0
    and position('encrypted_password' in v_normalized)=0 then
    return;
  end if;
  if position(v_expected in v_definition)=0 then
    raise exception 'Bloco legado de classificacao da migration 099 nao encontrado.';
  end if;

  v_definition:=replace(v_definition,v_expected,v_replacement);
  execute v_definition;
  select lower(pg_get_functiondef(v_signature)) into v_definition;
  if position('encrypted_password' in v_definition)>0
    or position('ph.source=''import''' in regexp_replace(v_definition,'\s+','','g'))=0 then
    raise exception 'Classificacao segura de reenvio nao foi instalada.';
  end if;
end;
$migration$;

revoke all on function public.check_participant_account_invite_eligibility(uuid)
  from public,anon,authenticated;
grant execute on function public.check_participant_account_invite_eligibility(uuid)
  to authenticated;

-- Nao existe evidencia historica capaz de provar que uma senha preexistente
-- foi criada durante este onboarding. Todo convite importado ativo anterior a
-- esta migration inicia sem conclusao; somente o novo fluxo pode grava-la.
update public.participant_account_invites pai
set
  requires_password_setup=true,
  password_setup_completed_at=null,
  updated_at=now()
where (pai.status='claimed' or (pai.status='pending' and pai.expires_at>now()))
  and exists(
    select 1 from public.participation_history ph
    where ph.participant_id=pai.participant_id
      and ph.event_id=pai.event_id
      and ph.source='import'
  )
  and not pai.requires_password_setup
  and pai.password_setup_completed_at is null;

create or replace function public.prepare_participant_account_invite(p_participant_id uuid)
returns table(invite_id uuid,email text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text;
  v_id uuid; v_check record; v_requires_password_setup boolean;
begin
  select * into v_check from public.check_participant_account_invite_eligibility(p_participant_id);
  if not coalesce(v_check.eligible,false) then raise exception '%',coalesce(v_check.reason_message,'Cadastro nao elegivel.'); end if;
  select * into v_p from public.participants where id=p_participant_id for update;
  v_email:=v_check.email;
  select exists(
    select 1 from public.participation_history ph
    where ph.participant_id=v_p.id and ph.event_id=v_p.event_id and ph.source='import'
  ) into v_requires_password_setup;
  update public.participant_account_invites set status='revoked',updated_at=now()
    where participant_id=v_p.id and status='pending' and expires_at<=now();
  insert into public.participant_account_invites(
    organization_id,event_id,participant_id,email,invited_by,requires_password_setup
  ) values(
    v_p.organization_id,v_p.event_id,v_p.id,v_email,v_actor,v_requires_password_setup
  )
  on conflict(participant_id) where status='pending' do update set
    email=excluded.email,invited_by=excluded.invited_by,
    expires_at=now()+interval '7 days',updated_at=now(),
    requires_password_setup=public.participant_account_invites.requires_password_setup
      or excluded.requires_password_setup
  returning id into v_id;
  return query select v_id,v_email;
end; $$;

revoke all on function public.prepare_participant_account_invite(uuid) from public,anon,authenticated;
grant execute on function public.prepare_participant_account_invite(uuid) to authenticated;

commit;
