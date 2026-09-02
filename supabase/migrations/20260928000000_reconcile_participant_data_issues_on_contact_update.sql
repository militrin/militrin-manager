-- Causa raiz do caso real (Central de Integridade, "Informe o genero para
-- calcular o valor.", 1 pedido afetado): registration_contacts.gender ja
-- estava preenchido ('male'), mas a pendencia (participant_data_issues,
-- field_code='gender', issue_type='missing_required_for_pricing') continuava
-- 'open'. Auditoria completa:
--
--   1) update_registration_contact_from_participant (fonte canonica de
--      escrita de dado pessoal, chamada por checkout, primeiro acesso,
--      edicao administrativa e Minha Conta -- 4 chamadores reais, grep
--      confirmado) so grava em registration_contacts. Nunca sincroniza a
--      projecao legada event-scoped (participants.gender/cpf/birth_date/...)
--      e nunca reavalia nenhuma participant_data_issues.
--
--   2) reevaluate_participant_data_issues(participant_id, import_batch_id)
--      -- a funcao estrutural (nunca por texto, so field_code/issue_type)
--      que reavalia issues E recalcula preco por genero -- JA EXISTIA desde
--      o baseline, mas nao tem NENHUM chamador real hoje (grep confirmado:
--      so aparece em 1 comentario). Ou seja, o mecanismo de reconciliacao
--      pedido pela auditoria ja existia, so nunca foi ligado a nada.
--
--   3) Mesmo se fosse chamada, reevaluate_participant_data_issues le
--      participants.gender/batch_id/ticket_category_id -- nunca
--      registration_contacts nem order_items. No caso real, participants.gender
--      ficou NULL (nunca sincronizado, ver #1) e participants.batch_id/
--      ticket_category_id tambem ficam NULL no fluxo contact-first moderno
--      (o lote/categoria reais vivem em order_items, nao mais em
--      participants -- ver 20260904000000_ticket_category_capacity_
--      order_items_source). O calculo de preco tambem so sabia escrever em
--      payments.participant_id (modelo legado de 1 pagamento por
--      participante) -- o pedido real usa orders/order_items/payments
--      (payments.id referenciado por orders.payment_id), nunca tocado.
--
-- Ou seja: nao e (A) genero salvo no lugar errado -- fef57597.../TIEVENT ja
-- tinha registration_contacts.gender='male' correto. E uma combinacao de
-- (D) participants (a projecao) nunca foi sincronizada, e (E) o fluxo que
-- gravou o dado (update_registration_contact_from_participant, chamado pelo
-- primeiro acesso) nunca disparou a reconciliacao que resolve_ticket_data_issues
-- so faz quando chamada explicitamente com o campo no payload -- e nem essa
-- teria resolvido sozinha, porque o preco moderno usa order_items/orders,
-- que reevaluate_participant_data_issues tambem nunca soube alcancar.
--
-- CORRECAO (fecha as 3 causas de uma vez, na fonte unica de escrita -- nunca
-- uma segunda arquitetura paralela):
--   a) update_registration_contact_from_participant passa a sincronizar
--      participants com o registration_contacts recem-gravado, e a chamar
--      reevaluate_participant_data_issues(participant_id) no final -- os 4
--      chamadores reais ganham reconciliacao automatica sem precisar saber
--      disso.
--   b) reevaluate_participant_data_issues passa a resolver lote/categoria
--      preferindo order_items (fonte canonica moderna, quando existe
--      order_item de ingresso vinculado ao participante) sobre
--      participants.batch_id/ticket_category_id (so usado como fallback
--      pro fluxo legado sem order_items).
--   c) o recalculo de preco por genero passa a escrever em order_items/
--      orders/payments (fluxo moderno, quando ha order_item de ingresso
--      vinculado) OU em payments.participant_id (fluxo legado, quando nao
--      ha) -- nunca os dois ao mesmo tempo, pra nao duplicar cobranca. Mesma
--      regra de seguranca ja auditada em resolve_ticket_data_issues
--      (20260922000000): nunca sobrescreve order_item/pedido/pagamento cujo
--      payment_status ja e 'paid'.
--
-- Idempotente: chamar de novo sem nenhuma mudanca real de dado nao altera
-- nada (issues ja resolvidas nao sao reabertas; preco ja correto nao muda;
-- pagamento ja pago nunca e tocado).
begin;

create or replace function public.reevaluate_participant_data_issues("p_participant_id" "uuid", "p_import_batch_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_e public.events%rowtype;
  v_price public.registration_batch_prices%rowtype; v_gender text; v_base numeric;
  v_age integer; v_open integer; v_issue record;
  v_batch_id uuid; v_category_id uuid; v_has_modern_order_item boolean;
  v_ticket_item public.order_items%rowtype; v_modern_order public.orders%rowtype; v_modern_payment public.payments%rowtype;
begin
  select * into v_p from public.participants where id=p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;
  select * into v_e from public.events where id=v_p.event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if v_actor is not null and v_actor is distinct from v_p.user_id
    and not public.user_can_access_organization(v_actor,v_e.organization_id) then
    raise exception 'Usuario sem acesso ao participante.';
  end if;

  create temporary table if not exists pg_temp.expected_import_issues(
    field_code text,issue_type text,message text,blocks_payment boolean,
    blocks_ticket_issuance boolean,blocks_checkin boolean,blocks_kit_delivery boolean,
    primary key(field_code,issue_type)
  ) on commit drop;
  truncate pg_temp.expected_import_issues;

  if nullif(trim(coalesce(v_p.cpf,'')),'') is null then
    insert into pg_temp.expected_import_issues values('cpf','missing_required_identity','CPF obrigatorio ausente.',false,true,false,false);
  elsif not public.is_valid_cpf(v_p.cpf) then
    insert into pg_temp.expected_import_issues values('cpf','invalid_identity','CPF invalido.',false,true,false,false);
  end if;

  if nullif(trim(coalesce(v_p.email,'')),'') is not null
    and v_p.email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    insert into pg_temp.expected_import_issues values('email','invalid_format','E-mail informado e invalido.',false,false,false,false);
  end if;
  if nullif(regexp_replace(coalesce(v_p.phone,''),'\D','','g'),'') is not null
    and length(regexp_replace(v_p.phone,'\D','','g')) not in(10,11) then
    insert into pg_temp.expected_import_issues values('phone','invalid_format','Telefone informado e invalido.',false,false,false,false);
  end if;

  if v_p.birth_date is null then
    insert into pg_temp.expected_import_issues values('birth_date','missing_required_age','Data de nascimento obrigatoria ausente.',false,true,false,false);
  elsif v_e.starts_at is null then
    insert into pg_temp.expected_import_issues values('event_date','missing_required_for_age','Evento sem data de inicio para validar maioridade.',false,true,false,false);
  elsif v_p.birth_date>v_e.starts_at::date then
    insert into pg_temp.expected_import_issues values('birth_date','invalid_date','Nascimento posterior a data do evento.',false,true,false,false);
  else
    v_age:=extract(year from age(v_e.starts_at::date,v_p.birth_date));
    if v_age<18 then
      insert into pg_temp.expected_import_issues values('birth_date','underage_at_event','Pessoa menor de 18 anos na data do evento.',false,true,false,false);
    end if;
  end if;

  -- Lote/categoria: fonte canonica e order_items (fluxo contact-first
  -- moderno -- participants.batch_id/ticket_category_id nunca sao
  -- preenchidos nesse fluxo, ver 20260904000000). So cai pro campo legado
  -- do participante quando nao ha order_item de ingresso vinculado.
  select oi.batch_id, oi.ticket_category_id into v_batch_id, v_category_id
    from public.order_items oi
    where oi.participant_id = v_p.id and oi.item_kind = 'ticket'
    order by oi.created_at limit 1;
  v_batch_id := coalesce(v_batch_id, v_p.batch_id);
  v_category_id := coalesce(v_category_id, v_p.ticket_category_id);

  if v_batch_id is null or not exists(select 1 from public.registration_batches rb where rb.id=v_batch_id and rb.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('batch','unresolved','Lote nao resolvido de forma deterministica.',true,true,false,false);
  end if;
  if v_category_id is null or not exists(select 1 from public.ticket_categories tc where tc.id=v_category_id and tc.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('category','unresolved','Categoria nao resolvida de forma deterministica.',true,true,false,false);
  end if;

  if v_batch_id is not null and v_category_id is not null then
    select * into v_price from public.registration_batch_prices
    where batch_id=v_batch_id and ticket_category_id=v_category_id;
    if not found then
      insert into pg_temp.expected_import_issues values('price','unresolved','Preco nao encontrado para lote e categoria.',true,true,false,false);
    end if;
  end if;

  v_gender:=lower(trim(coalesce(v_p.gender,'')));
  if v_price.id is not null and v_price.male_price is distinct from v_price.female_price
    and v_gender not in('masculino','male','m','feminino','female','f') then
    insert into pg_temp.expected_import_issues values('gender','missing_required_for_pricing','Informe o genero para calcular o valor.',true,true,false,false);
  end if;

  if coalesce(v_e.limit_shirt_selection_to_stock,false)
    and exists(select 1 from public.event_kit_items where event_id=v_e.id and item_type='shirt' and is_active=true)
    and (nullif(trim(v_p.shirt_type),'') is null or nullif(trim(v_p.shirt_size),'') is null) then
    insert into pg_temp.expected_import_issues values('shirt_selection','missing_required_for_inventory','Modelo e tamanho da camiseta pendentes para o kit.',false,false,false,true);
  end if;

  update public.participant_data_issues i set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
  where i.participant_id=v_p.id and i.status='open'
    and i.field_code in('cpf','email','phone','birth_date','event_date','batch','category','price','gender','shirt_selection')
    and not exists(select 1 from pg_temp.expected_import_issues e where e.field_code=i.field_code and e.issue_type=i.issue_type);

  for v_issue in select * from pg_temp.expected_import_issues loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,import_batch_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)
    values(v_e.organization_id,v_e.id,v_p.id,p_import_batch_id,v_issue.field_code,v_issue.issue_type,
      v_issue.message,v_issue.blocks_payment,v_issue.blocks_ticket_issuance,v_issue.blocks_checkin,v_issue.blocks_kit_delivery)
    on conflict do nothing;
  end loop;

  if v_price.id is not null then
    v_base:=case when v_gender in('feminino','female','f') then v_price.female_price
      when v_gender in('masculino','male','m') then v_price.male_price
      when v_price.male_price=v_price.female_price then v_price.male_price end;
    if v_base is not null then
      v_has_modern_order_item := exists(
        select 1 from public.order_items oi where oi.participant_id = v_p.id and oi.item_kind = 'ticket'
      );
      if v_has_modern_order_item then
        -- Fluxo contact-first moderno -- mesma logica e mesmo guard de
        -- resolve_ticket_data_issues (20260922000000): nunca sobrescreve
        -- order_item/pedido/pagamento ja pago.
        for v_ticket_item in
          select * from public.order_items
          where participant_id = v_p.id and item_kind = 'ticket'
            and batch_id = v_batch_id and ticket_category_id = v_category_id
        loop
          select * into v_modern_order from public.orders where id = v_ticket_item.order_id;
          if found then
            select * into v_modern_payment from public.payments where id = v_modern_order.payment_id;
            if coalesce(v_modern_payment.payment_status,'pending') <> 'paid' then
              update public.order_items set unit_price=round(v_base,2), final_amount=round(v_base,2), updated_at=now() where id=v_ticket_item.id;
              update public.orders set base_amount=round(v_base,2), final_amount=round(v_base,2) where id=v_modern_order.id;
              if v_modern_payment.id is not null then
                update public.payments set amount=round(v_base,2), final_amount=round(v_base,2), updated_at=now() where id=v_modern_payment.id;
              end if;
            end if;
          end if;
        end loop;
      else
        -- Fluxo legado (payments.participant_id, sem order_items vinculado)
        -- -- comportamento original preservado integralmente.
        update public.payments set amount=round(v_base,2),discount_amount=0,final_amount=round(v_base,2),updated_at=now()
        where participant_id=v_p.id and payment_status<>'paid';
        if not exists(select 1 from public.payments where participant_id=v_p.id and event_id=v_p.event_id) then
          insert into public.payments(participant_id,event_id,amount,discount_amount,final_amount,payment_method,payment_status)
          values(v_p.id,v_p.event_id,round(v_base,2),0,round(v_base,2),'pix','pending');
        end if;
      end if;
    end if;
  end if;

  select count(*) into v_open from public.participant_data_issues where participant_id=v_p.id and status='open';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('participant_data_issues_reevaluated','participants',v_p.id,v_e.id,
    jsonb_build_object('actor_user_id',v_actor,'import_batch_id',p_import_batch_id,'open_issue_count',v_open,'source',case when p_import_batch_id is null then 'edit' else 'import' end));
  return jsonb_build_object('participant_id',v_p.id,'open_issue_count',v_open,'price_defined',v_base is not null);
end; $_$;

create or replace function public.update_registration_contact_from_participant(
  p_participant_id uuid,p_values jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype;
  v_key text; v_allowed constant text[]:=array['full_name','cpf','birth_date','gender','phone','email','city'];
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_participant from public.participants where id=p_participant_id for update;
  if not found or v_participant.registration_contact_id is null then raise exception 'Cadastro global nao vinculado.'; end if;
  if v_participant.user_id is distinct from v_actor and not(
    public.user_can_access_organization(v_actor,v_participant.organization_id)
    and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic'))
  ) then raise exception 'Usuario sem acesso ao cadastro.'; end if;
  for v_key in select jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) loop
    if not(v_key=any(v_allowed)) then raise exception 'Campo pessoal nao permitido.'; end if;
  end loop;
  if p_values?'cpf' and nullif(p_values->>'cpf','') is not null and not public.is_valid_cpf(p_values->>'cpf') then raise exception 'CPF invalido.'; end if;
  update public.registration_contacts rc set
    full_name=case when p_values?'full_name' then nullif(trim(p_values->>'full_name'),'') else rc.full_name end,
    cpf=case when p_values?'cpf' then nullif(regexp_replace(p_values->>'cpf','\D','','g'),'') else rc.cpf end,
    birth_date=case when p_values?'birth_date' then nullif(trim(p_values->>'birth_date'),'')::date else rc.birth_date end,
    gender=case when p_values?'gender' then nullif(trim(p_values->>'gender'),'') else rc.gender end,
    phone=case when p_values?'phone' then nullif(regexp_replace(p_values->>'phone','\D','','g'),'') else rc.phone end,
    email=case when p_values?'email' then lower(nullif(trim(p_values->>'email'),'')) else rc.email end,
    city=case when p_values?'city' then nullif(trim(p_values->>'city'),'') else rc.city end,
    updated_at=now()
  where rc.id=v_participant.registration_contact_id returning * into v_contact;

  -- Sincroniza a projecao legada event-scoped (participants) com a fonte
  -- canonica que acabou de ser gravada -- sem isso, qualquer consumidor que
  -- ainda leia participants.* (incluindo reevaluate_participant_data_issues,
  -- chamada logo abaixo) ve dado desatualizado. Bug real corrigido aqui:
  -- genero informado no primeiro acesso ficava so em registration_contacts,
  -- nunca em participants, e a pendencia de Integridade nunca era reavaliada.
  update public.participants p set
    full_name=v_contact.full_name, cpf=v_contact.cpf, birth_date=v_contact.birth_date, gender=v_contact.gender,
    phone=v_contact.phone, email=v_contact.email, city=v_contact.city, updated_at=now()
  where p.id=v_participant.id;

  -- Reavalia estruturalmente (por field_code/issue_type, nunca por texto da
  -- mensagem) quais participant_data_issues continuam validas a partir do
  -- estado atual -- resolve o que deixou de se aplicar, preserva o que
  -- continua em aberto, e recalcula o preco dependente de genero quando
  -- aplicavel. Idempotente. Os 4 chamadores reais desta funcao (checkout,
  -- primeiro acesso, edicao administrativa, Minha Conta) ganham
  -- reconciliacao automatica sem precisar saber disso.
  perform public.reevaluate_participant_data_issues(v_participant.id);

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('registration_contact_personal_data_updated','registration_contacts',v_contact.id,v_participant.event_id,
    jsonb_build_object('actor_user_id',v_actor,'participant_projection_id',v_participant.id,'fields_updated',
      (select coalesce(jsonb_agg(k),'[]'::jsonb) from jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) k)));
  return jsonb_build_object('success',true,'registration_contact_id',v_contact.id);
end; $$;

commit;
