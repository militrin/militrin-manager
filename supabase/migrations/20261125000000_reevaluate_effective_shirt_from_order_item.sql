-- Camiseta efetiva no reevaluate: order_item do ingresso do participante
-- neste evento, com fallback para participants.shirt_*.
-- Nao abre shirt_selection/missing_required_for_inventory so porque a
-- projecao legada esta nula quando o ingresso comercial ja tem modelo e
-- tamanho. Nao usa order_item de outro contato/holder/ingresso.
-- Divergencia participant vs item comercial nao e mascarada: issue conflict
-- (nao bloqueia kit) enquanto o item comercial estiver completo.
-- Sem DML de estoque / kit / variant.

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
  v_ticket_reconciliation jsonb; v_legacy_historical boolean;
  v_own_ticket_item_count integer := 0;
  v_divergent_commercial_shirt boolean := false;
  v_missing_effective_shirt boolean := false;
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

  select oi.batch_id, oi.ticket_category_id into v_batch_id, v_category_id
    from public.order_items oi
    where oi.participant_id = v_p.id and oi.item_kind = 'ticket'
    order by oi.created_at limit 1;
  v_batch_id := coalesce(v_batch_id, v_p.batch_id);
  v_category_id := coalesce(v_category_id, v_p.ticket_category_id);

  select exists(
    select 1 from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.participant_id = v_p.id and oi.item_kind = 'ticket'
      and public.is_legacy_import_historical_price(coalesce(oi.price_origin, o.price_origin))
  ) into v_legacy_historical;

  if v_batch_id is null or not exists(select 1 from public.registration_batches rb where rb.id=v_batch_id and rb.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('batch','unresolved','Lote nao resolvido de forma deterministica.',true,true,false,false);
  end if;
  if v_category_id is null or not exists(select 1 from public.ticket_categories tc where tc.id=v_category_id and tc.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('category','unresolved','Categoria nao resolvida de forma deterministica.',true,true,false,false);
  end if;

  if v_batch_id is not null and v_category_id is not null then
    select * into v_price from public.registration_batch_prices
    where batch_id=v_batch_id and ticket_category_id=v_category_id;
    if not found and not v_legacy_historical then
      insert into pg_temp.expected_import_issues values('price','unresolved','Preco nao encontrado para lote e categoria.',true,true,false,false);
    end if;
  end if;

  v_gender:=lower(trim(coalesce(v_p.gender,'')));
  if not v_legacy_historical
    and v_price.id is not null and v_price.male_price is distinct from v_price.female_price
    and v_gender not in('masculino','male','m','feminino','female','f') then
    insert into pg_temp.expected_import_issues values('gender','missing_required_for_pricing','Informe o genero para calcular o valor.',true,true,false,false);
  end if;

  -- Camiseta efetiva: ingresso comercial deste participante neste evento.
  -- Nunca registration_contact_id sozinho (evita camiseta de outra compra).
  select count(*)::integer into v_own_ticket_item_count
  from public.tickets t
  join public.order_items oi on oi.id = t.order_item_id
  where t.event_id = v_p.event_id
    and oi.event_id = v_p.event_id
    and t.status in ('active','used')
    and coalesce(oi.item_kind,'ticket') = 'ticket'
    and oi.status not in ('cancelled','expired','refunded','transferred')
    and (t.participant_id = v_p.id or oi.participant_id = v_p.id);

  if v_own_ticket_item_count = 0 then
    select count(*)::integer into v_own_ticket_item_count
    from public.order_items oi
    where oi.participant_id = v_p.id
      and oi.event_id = v_p.event_id
      and coalesce(oi.item_kind,'ticket') = 'ticket'
      and oi.status not in ('cancelled','expired','refunded','transferred');
  end if;

  if v_own_ticket_item_count > 0 then
    if exists (
      select 1
      from public.tickets t
      join public.order_items oi on oi.id = t.order_item_id
      where t.event_id = v_p.event_id
        and oi.event_id = v_p.event_id
        and t.status in ('active','used')
        and coalesce(oi.item_kind,'ticket') = 'ticket'
        and oi.status not in ('cancelled','expired','refunded','transferred')
        and (t.participant_id = v_p.id or oi.participant_id = v_p.id)
        and (nullif(trim(oi.shirt_type),'') is null or nullif(trim(oi.shirt_size),'') is null)
        and (nullif(trim(v_p.shirt_type),'') is null or nullif(trim(v_p.shirt_size),'') is null)
    ) or (
      not exists (
        select 1
        from public.tickets t
        join public.order_items oi on oi.id = t.order_item_id
        where t.event_id = v_p.event_id
          and oi.event_id = v_p.event_id
          and t.status in ('active','used')
          and coalesce(oi.item_kind,'ticket') = 'ticket'
          and oi.status not in ('cancelled','expired','refunded','transferred')
          and (t.participant_id = v_p.id or oi.participant_id = v_p.id)
      )
      and exists (
        select 1
        from public.order_items oi
        where oi.participant_id = v_p.id
          and oi.event_id = v_p.event_id
          and coalesce(oi.item_kind,'ticket') = 'ticket'
          and oi.status not in ('cancelled','expired','refunded','transferred')
          and (nullif(trim(oi.shirt_type),'') is null or nullif(trim(oi.shirt_size),'') is null)
          and (nullif(trim(v_p.shirt_type),'') is null or nullif(trim(v_p.shirt_size),'') is null)
      )
    ) then
      v_missing_effective_shirt := true;
    end if;

    select coalesce(bool_or(
      nullif(trim(oi.shirt_type),'') is not null
      and nullif(trim(oi.shirt_size),'') is not null
      and nullif(trim(v_p.shirt_type),'') is not null
      and nullif(trim(v_p.shirt_size),'') is not null
      and (
        lower(trim(oi.shirt_type)) is distinct from lower(trim(v_p.shirt_type))
        or upper(trim(oi.shirt_size)) is distinct from upper(trim(v_p.shirt_size))
      )
    ), false) into v_divergent_commercial_shirt
    from public.tickets t
    join public.order_items oi on oi.id = t.order_item_id
    where t.event_id = v_p.event_id
      and oi.event_id = v_p.event_id
      and t.status in ('active','used')
      and coalesce(oi.item_kind,'ticket') = 'ticket'
      and oi.status not in ('cancelled','expired','refunded','transferred')
      and (t.participant_id = v_p.id or oi.participant_id = v_p.id);

    if not v_divergent_commercial_shirt then
      select coalesce(bool_or(
        nullif(trim(oi.shirt_type),'') is not null
        and nullif(trim(oi.shirt_size),'') is not null
        and nullif(trim(v_p.shirt_type),'') is not null
        and nullif(trim(v_p.shirt_size),'') is not null
        and (
          lower(trim(oi.shirt_type)) is distinct from lower(trim(v_p.shirt_type))
          or upper(trim(oi.shirt_size)) is distinct from upper(trim(v_p.shirt_size))
        )
      ), false) into v_divergent_commercial_shirt
      from public.order_items oi
      where oi.participant_id = v_p.id
        and oi.event_id = v_p.event_id
        and coalesce(oi.item_kind,'ticket') = 'ticket'
        and oi.status not in ('cancelled','expired','refunded','transferred');
    end if;
  else
    if nullif(trim(v_p.shirt_type),'') is null or nullif(trim(v_p.shirt_size),'') is null then
      v_missing_effective_shirt := true;
    end if;
  end if;

  if coalesce(v_e.limit_shirt_selection_to_stock,false)
    and exists(select 1 from public.event_kit_items where event_id=v_e.id and item_type='shirt' and is_active=true) then
    if v_missing_effective_shirt then
      insert into pg_temp.expected_import_issues values('shirt_selection','missing_required_for_inventory','Modelo e tamanho da camiseta pendentes para o kit.',false,false,false,true);
    end if;
    if v_divergent_commercial_shirt then
      insert into pg_temp.expected_import_issues values('shirt_selection','conflict','Camiseta do cadastro diverge da camiseta comercial do ingresso.',false,false,false,false);
    end if;
  end if;

  update public.participant_data_issues i set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
  where i.participant_id=v_p.id and i.status='open'
    and i.field_code in('full_name','cpf','email','phone','city','birth_date','event_date','batch','category','price','gender','shirt_selection')
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
        for v_ticket_item in
          select * from public.order_items
          where participant_id = v_p.id and item_kind = 'ticket'
            and batch_id = v_batch_id and ticket_category_id = v_category_id
        loop
          select * into v_modern_order from public.orders where id = v_ticket_item.order_id;
          if found and not public.is_legacy_import_historical_price(coalesce(v_ticket_item.price_origin, v_modern_order.price_origin)) then
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
      elsif not v_legacy_historical then
        update public.payments set amount=round(v_base,2),discount_amount=0,final_amount=round(v_base,2),updated_at=now()
        where participant_id=v_p.id and payment_status<>'paid';
        if not exists(select 1 from public.payments where participant_id=v_p.id and event_id=v_p.event_id) then
          insert into public.payments(participant_id,event_id,amount,discount_amount,final_amount,payment_method,payment_status)
          values(v_p.id,v_p.event_id,round(v_base,2),0,round(v_base,2),'pix','pending');
        end if;
      end if;
    end if;
  end if;

  if exists(select 1 from public.order_items oi where oi.participant_id = v_p.id and oi.item_kind = 'ticket') then
    v_ticket_reconciliation := public.reconcile_imported_ticket_issuance_for_participant(v_p.id);
  else
    v_ticket_reconciliation := jsonb_build_object('attempted', 0, 'results', '[]'::jsonb);
  end if;

  select count(*) into v_open from public.participant_data_issues where participant_id=v_p.id and status='open';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('participant_data_issues_reevaluated','participants',v_p.id,v_e.id,
    jsonb_build_object('actor_user_id',v_actor,'import_batch_id',p_import_batch_id,'open_issue_count',v_open,'source',case when p_import_batch_id is null then 'edit' else 'import' end));
  return jsonb_build_object('participant_id',v_p.id,'open_issue_count',v_open,'price_defined',v_base is not null,'ticket_reconciliation',v_ticket_reconciliation);
end; $_$;

revoke all on function public.reevaluate_participant_data_issues(uuid, uuid) from public, anon;
grant execute on function public.reevaluate_participant_data_issues(uuid, uuid) to authenticated, service_role;

commit;
