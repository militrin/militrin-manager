-- Bug: Editar cadastro (Cadastros -> Editar cadastro) informava sucesso mas
-- nao persistia o nome (nem nenhum outro campo). Causa raiz: registration_contacts
-- tem RLS habilitado (20260815001914) mas SOMENTE uma policy de SELECT
-- (registration_contacts_org_select) -- nunca existiu policy de UPDATE/INSERT.
-- updateCadastroAction (src/app/cadastros/[id]/editar/actions.ts) fazia um
-- .update() direto na tabela com o client autenticado (nao service role): o
-- RLS descartava silenciosamente a operacao (0 linhas afetadas), o Postgres/
-- PostgREST nao gera erro nesse caso, e a action seguia pro redirect de
-- sucesso sem nada gravado.
--
-- Fix: escrita passa a ser SOMENTE via RPC SECURITY DEFINER, mesmo padrao ja
-- usado pelo projeto para mutacoes sensiveis de registration_contacts
-- (owner_delete_empty_registration_contact, 20260894000000) -- permissao
-- explicita (participants.edit_basic) + acesso a organizacao verificados no
-- backend, e GET DIAGNOSTICS confirma que a linha foi mesmo afetada antes de
-- reportar sucesso. Nao toca em orders/order_items/participants/tickets --
-- cadastro (dado pessoal) continua independente de comprador/titular/
-- propriedade do ingresso.
begin;

create or replace function public.update_registration_contact_basic_info(
  p_contact_id uuid,
  p_full_name text,
  p_cpf text,
  p_birth_date date,
  p_gender text,
  p_phone text,
  p_email text,
  p_city text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_full_name text := trim(coalesce(p_full_name, ''));
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  v_phone text := trim(coalesce(p_phone, ''));
  v_email text := lower(trim(coalesce(p_email, '')));
  v_gender text := nullif(trim(coalesce(p_gender, '')), '');
  v_city text := nullif(trim(coalesce(p_city, '')), '');
  v_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para editar cadastro.';
  end if;

  select * into v_contact from public.registration_contacts where id = p_contact_id for update;
  if not found then raise exception 'Cadastro nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    raise exception 'Sem acesso a este cadastro.';
  end if;

  if v_full_name = '' then raise exception 'Nome obrigatorio.'; end if;
  if v_cpf = '' or p_birth_date is null or v_phone = '' or v_email = '' then
    raise exception 'CPF, nascimento, telefone e e-mail sao obrigatorios neste cadastro.';
  end if;

  update public.registration_contacts set
    full_name = v_full_name,
    cpf = v_cpf,
    birth_date = p_birth_date,
    gender = v_gender,
    phone = v_phone,
    email = v_email,
    city = v_city,
    updated_at = now()
  where id = p_contact_id;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Nao foi possivel salvar o cadastro.';
  end if;

  return jsonb_build_object('success', true, 'contact_id', p_contact_id, 'full_name', v_full_name);
exception
  when unique_violation then
    raise exception 'Ja existe outro cadastro com este CPF nesta organizacao.';
end;
$$;

revoke all on function public.update_registration_contact_basic_info(uuid, text, text, date, text, text, text, text)
  from public, anon;
grant execute on function public.update_registration_contact_basic_info(uuid, text, text, date, text, text, text, text)
  to authenticated, service_role;

commit;
