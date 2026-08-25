begin;

create or replace function public.owner_delete_empty_registration_contact(
  p_registration_contact_id uuid,
  p_confirmation text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;

  select contact.* into v_contact
  from public.registration_contacts as contact
  where contact.id = p_registration_contact_id
  for update;
  if not found then raise exception 'Cadastro nao encontrado.'; end if;
  if not public.is_organization_owner(v_actor, v_contact.organization_id) then
    raise exception 'Somente o Owner da organizacao pode excluir cadastros.';
  end if;
  if lower(trim(coalesce(p_confirmation, ''))) <> lower(trim(v_contact.full_name)) then
    raise exception 'Digite o nome completo da Pessoa para confirmar.';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Informe o motivo da exclusao.';
  end if;

  if v_contact.user_id is not null then
    raise exception 'Este cadastro possui conta vinculada. Desvincule ou trate a conta antes de excluir a Pessoa.';
  end if;
  if exists (
    select 1 from public.participants as participant
    where participant.registration_contact_id = v_contact.id
  ) then
    raise exception 'Este cadastro possui participacao em evento. Exclua ou transfira os vinculos antes.';
  end if;
  if exists (
    select 1 from public.order_items as item
    where item.registration_contact_id = v_contact.id
  ) then
    raise exception 'Este cadastro possui pedido ou ingresso vinculado. Trate esses registros antes.';
  end if;
  if exists (
    select 1 from public.store_orders as store_order
    where store_order.registration_contact_id = v_contact.id
  ) then
    raise exception 'Este cadastro possui itens adicionais vinculados. Trate esses registros antes.';
  end if;
  if to_regclass('public.sponsors') is not null and exists (
    select 1 from public.sponsors as sponsor
    where sponsor.registration_contact_id = v_contact.id
  ) then
    raise exception 'Este cadastro esta vinculado a um patrocinador. Remova o vinculo antes.';
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'registration_contact_deleted', 'registration_contacts', v_contact.id, null,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_contact.organization_id,
      'full_name', v_contact.full_name,
      'reason', trim(p_reason),
      'deleted_at', now()
    )
  );

  -- Convites ancorados exclusivamente nesta Pessoa usam ON DELETE CASCADE.
  delete from public.registration_contacts as contact where contact.id = v_contact.id;
  return jsonb_build_object('success', true, 'contact_id', v_contact.id);
end;
$$;

revoke all on function public.owner_delete_empty_registration_contact(uuid, text, text)
  from public, anon;
grant execute on function public.owner_delete_empty_registration_contact(uuid, text, text)
  to authenticated, service_role;

commit;
