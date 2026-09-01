begin;

-- Contas criadas por inviteUserByEmail nao escolheram uma senha. Toda
-- invitacao de primeiro acesso ainda nao concluida deve portanto manter as
-- duas etapas de onboarding ativas, independentemente de o convite ter sido
-- preparado pelo caminho legado de participant ou pelo caminho canonico de
-- registration_contact.
create or replace function public.enforce_account_invite_onboarding_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('pending', 'claimed')
    and new.password_setup_completed_at is null then
    new.requires_password_setup := true;

    if new.auth_user_id is not null then
      insert into public.customer_profiles(
        user_id, account_status, must_change_password, must_complete_profile
      ) values (
        new.auth_user_id, 'pending_activation', true, true
      )
      on conflict(user_id) do update set
        account_status = case
          when public.customer_profiles.account_status = 'blocked' then 'blocked'
          else 'pending_activation'
        end,
        must_change_password = true,
        must_complete_profile = true,
        updated_at = now();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_account_invite_onboarding_state
  on public.participant_account_invites;
create trigger trg_enforce_account_invite_onboarding_state
before insert or update of status, auth_user_id, requires_password_setup,
  password_setup_completed_at
on public.participant_account_invites
for each row execute function public.enforce_account_invite_onboarding_state();

-- Corrige convites ja emitidos pelo prepare_registration_contact_account_invite,
-- que historicamente gravava requires_password_setup=false. O UPDATE tambem
-- aciona o trigger acima e restaura as flags do perfil correlacionado.
update public.participant_account_invites
set requires_password_setup = true,
    updated_at = now()
where status in ('pending', 'claimed')
  and password_setup_completed_at is null
  and requires_password_setup = false;

revoke all on function public.enforce_account_invite_onboarding_state()
  from public, anon, authenticated;

commit;
