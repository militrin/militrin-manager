-- 094_safe_current_event_import_phase1_preflight.sql
-- Somente leitura. Valida as precondicoes da Fase 1 do importador.

select table_name,column_name,is_nullable,data_type
from information_schema.columns
where table_schema='public'
  and table_name in('participants','customer_profiles','events','registration_batches','ticket_categories',
    'registration_batch_prices','import_batches','import_batch_rows','participant_data_issues',
    'payments','orders','order_items','tickets','ticket_holder_history')
order by table_name,ordinal_position;

select con.conname,con.conrelid::regclass as relation,pg_get_constraintdef(con.oid) as definition
from pg_constraint con
where con.conrelid in(
  'public.participants'::regclass,
  'public.import_batch_rows'::regclass,
  'public.participant_data_issues'::regclass,
  'public.orders'::regclass
)
order by con.conrelid::regclass::text,con.conname;

select event_id,regexp_replace(cpf,'\D','','g') as normalized_cpf,count(*) as participant_count,
  array_agg(id order by id) as participant_ids
from public.participants
where nullif(regexp_replace(coalesce(cpf,''),'\D','','g'),'') is not null
group by event_id,regexp_replace(cpf,'\D','','g')
having count(*)>1
order by participant_count desc,event_id;

select p.id,p.event_id,p.user_id,p.full_name,p.cpf,p.birth_date,p.email,p.phone,p.batch_id,
  p.ticket_category_id,p.registration_status
from public.participants p
where exists(
  select 1 from public.participation_history ph
  where ph.participant_id=p.id and ph.source='import'
)
order by p.event_id,p.created_at,p.id;

select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as result
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in(
  'reevaluate_participant_data_issues',
  'resolve_participant_data_issues',
  'create_pending_imported_participant',
  'create_imported_order_and_issue_ticket',
  'finalize_imported_participant_after_issue_resolution',
  'change_ticket_holder_by_pin_internal'
)
order by p.proname,arguments;

select ib.id as import_batch_id,ib.event_id,ib.imported_by,ib.status,
  count(ibr.id) as row_count,
  count(*) filter(where ibr.matched_user_id=ib.imported_by) as rows_matching_operator_user
from public.import_batches ib
left join public.import_batch_rows ibr on ibr.import_batch_id=ib.id
where ib.import_type='current_event_registrations'
group by ib.id,ib.event_id,ib.imported_by,ib.status
order by ib.created_at desc;

-- Resumo final: uma unica linha, sem chamar RPCs e sem modificar dados.
with
required_columns(table_name,column_name,data_type) as (values
  ('participants','id','uuid'),('participants','event_id','uuid'),('participants','organization_id','uuid'),
  ('participants','user_id','uuid'),('participants','full_name','text'),('participants','cpf','text'),
  ('participants','birth_date','date'),('participants','gender','text'),('participants','phone','text'),
  ('participants','email','text'),('participants','city','text'),('participants','shirt_type','text'),
  ('participants','shirt_size','text'),('participants','registration_status','text'),
  ('participants','reservation_status','text'),('participants','batch_id','uuid'),
  ('participants','ticket_category_id','uuid'),('participants','notes','text'),
  ('participants','created_at','timestamp with time zone'),('participants','updated_at','timestamp with time zone'),
  ('customer_profiles','user_id','uuid'),('customer_profiles','public_pin','text'),
  ('customer_profiles','account_status','text'),('customer_profiles','full_name','text'),
  ('customer_profiles','cpf','text'),('customer_profiles','birth_date','date'),
  ('customer_profiles','gender','text'),('customer_profiles','phone','text'),
  ('customer_profiles','city','text'),
  ('events','id','uuid'),('events','organization_id','uuid'),
  ('events','starts_at','timestamp with time zone'),('events','limit_shirt_selection_to_stock','boolean'),
  ('events','allow_holder_change','boolean'),('events','allow_ticket_transfer','boolean'),
  ('registration_batches','id','uuid'),('registration_batches','event_id','uuid'),
  ('registration_batches','name','text'),('registration_batches','is_active','boolean'),
  ('ticket_categories','id','uuid'),('ticket_categories','event_id','uuid'),
  ('ticket_categories','name','text'),('ticket_categories','is_active','boolean'),
  ('registration_batch_prices','id','uuid'),('registration_batch_prices','batch_id','uuid'),
  ('registration_batch_prices','ticket_category_id','uuid'),
  ('registration_batch_prices','male_price','numeric'),('registration_batch_prices','female_price','numeric'),
  ('import_batches','id','uuid'),('import_batches','event_id','uuid'),
  ('import_batches','import_type','text'),('import_batches','imported_by','uuid'),
  ('import_batches','payment_mode_original','text'),
  ('import_batch_rows','id','uuid'),('import_batch_rows','import_batch_id','uuid'),
  ('import_batch_rows','row_number','integer'),('import_batch_rows','status','text'),
  ('import_batch_rows','resolution','text'),('import_batch_rows','normalized_data','jsonb'),
  ('import_batch_rows','data_issues','jsonb'),('import_batch_rows','matched_participant_id','uuid'),
  ('import_batch_rows','matched_user_id','uuid'),
  ('participant_data_issues','participant_id','uuid'),('participant_data_issues','import_batch_id','uuid'),
  ('participant_data_issues','organization_id','uuid'),('participant_data_issues','event_id','uuid'),
  ('participant_data_issues','field_code','text'),('participant_data_issues','issue_type','text'),
  ('participant_data_issues','message','text'),
  ('participant_data_issues','status','text'),('participant_data_issues','blocks_payment','boolean'),
  ('participant_data_issues','blocks_ticket_issuance','boolean'),
  ('participant_data_issues','blocks_checkin','boolean'),
  ('participant_data_issues','blocks_kit_delivery','boolean'),
  ('participant_data_issues','resolved_at','timestamp with time zone'),
  ('participant_data_issues','resolved_by','uuid'),
  ('participant_data_issues','updated_at','timestamp with time zone'),
  ('payments','id','uuid'),('payments','participant_id','uuid'),('payments','event_id','uuid'),
  ('payments','order_id','uuid'),('payments','payment_method','text'),('payments','payment_status','text'),
  ('payments','amount','numeric'),('payments','discount_amount','numeric'),('payments','final_amount','numeric'),
  ('payments','paid_at','timestamp with time zone'),('payments','created_at','timestamp with time zone'),
  ('payments','updated_at','timestamp with time zone'),
  ('orders','id','uuid'),('orders','participant_id','uuid'),('orders','event_id','uuid'),
  ('orders','user_id','uuid'),('orders','payment_id','uuid'),('orders','order_number','text'),
  ('orders','status','text'),('orders','base_amount','numeric'),('orders','discount_amount','numeric'),
  ('orders','final_amount','numeric'),('orders','buyer_type','text'),('orders','import_batch_id','uuid'),
  ('orders','confirmed_at','timestamp with time zone'),
  ('order_items','id','uuid'),('order_items','order_id','uuid'),('order_items','participant_id','uuid'),
  ('order_items','event_id','uuid'),('order_items','ownership_status','text'),
  ('order_items','holder_full_name','text'),('order_items','ticket_category_id','uuid'),
  ('order_items','batch_id','uuid'),('order_items','shirt_type','text'),('order_items','shirt_size','text'),
  ('order_items','quantity','integer'),('order_items','unit_price','numeric'),
  ('order_items','discount_amount','numeric'),('order_items','final_amount','numeric'),
  ('order_items','status','text'),('order_items','updated_at','timestamp with time zone'),
  ('tickets','id','uuid'),('tickets','order_id','uuid'),('tickets','order_item_id','uuid'),
  ('tickets','event_id','uuid'),('tickets','organization_id','uuid'),
  ('tickets','participant_id','uuid'),('tickets','status','text'),
  ('ticket_holder_history','ticket_id','uuid'),('ticket_holder_history','order_item_id','uuid'),
  ('ticket_holder_history','event_id','uuid'),('ticket_holder_history','organization_id','uuid'),
  ('ticket_holder_history','operation','text'),('ticket_holder_history','previous_participant_id','uuid'),
  ('ticket_holder_history','new_participant_id','uuid'),('ticket_holder_history','previous_user_id','uuid'),
  ('ticket_holder_history','new_user_id','uuid'),('ticket_holder_history','actor_user_id','uuid'),
  ('ticket_holder_history','actor_origin','text'),('ticket_holder_history','reason','text'),
  ('participation_history','participant_id','uuid'),('participation_history','import_batch_id','uuid'),
  ('participation_history','event_id','uuid'),('participation_history','source','text'),
  ('event_kit_items','event_id','uuid'),('event_kit_items','item_type','text'),
  ('event_kit_items','is_active','boolean'),
  ('audit_logs','action','text'),('audit_logs','entity_type','text'),('audit_logs','entity_id','uuid'),
  ('audit_logs','event_id','uuid'),('audit_logs','details','jsonb')
),
schema_incompatibilities as (
  select rc.table_name,rc.column_name,rc.data_type as expected_type,c.data_type as actual_type
  from required_columns rc
  left join information_schema.columns c
    on c.table_schema='public' and c.table_name=rc.table_name and c.column_name=rc.column_name
  where c.column_name is null or c.data_type<>rc.data_type
),
schema_compatibility_diagnostic as (
  select
    rc.table_name,
    rc.column_name as expected_column,
    rc.data_type as expected_type,
    case
      -- A 094 remove NOT NULL de phone, portanto o estado anterior pode ser YES ou NO.
      -- Para email, a 094 remove apenas o CHECK legado e pressupoe a coluna nullable.
      when rc.table_name='participants' and rc.column_name='email' then 'YES'
      else 'ANY'
    end as expected_nullable,
    c.column_name is not null as "exists",
    c.data_type as actual_type,
    c.is_nullable as actual_nullable,
    case
      when c.column_name is null then 'missing'
      when c.data_type<>rc.data_type then 'incompatible_type'
      when rc.table_name='participants' and rc.column_name='email' and c.is_nullable<>'YES'
        then 'incompatible_nullability'
      else 'compatible'
    end as status
  from required_columns rc
  left join information_schema.columns c
    on c.table_schema='public' and c.table_name=rc.table_name and c.column_name=rc.column_name
),
required_functions(function_name,signature) as (values
  ('user_can_access_organization','public.user_can_access_organization(uuid,uuid)'),
  ('current_user_has_permission','public.current_user_has_permission(text)'),
  ('is_active_owner','public.is_active_owner(uuid)'),
  ('resolve_user_permission','public.resolve_user_permission(uuid,text)'),
  ('generate_order_number','public.generate_order_number()'),
  ('confirm_order_item_and_issue_ticket','public.confirm_order_item_and_issue_ticket(uuid)'),
  ('reevaluate_participant_data_issues','public.reevaluate_participant_data_issues(uuid,uuid)'),
  ('resolve_participant_data_issues','public.resolve_participant_data_issues(uuid,uuid[],jsonb)'),
  ('create_imported_order_and_issue_ticket','public.create_imported_order_and_issue_ticket(uuid,uuid)'),
  ('finalize_imported_participant_after_issue_resolution',
    'public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)'),
  ('change_ticket_holder_by_pin_internal',
    'public.change_ticket_holder_by_pin_internal(uuid,text,text,boolean,text)')
),
missing_functions as (
  select * from required_functions where to_regprocedure(signature) is null
),
unexpected_signatures as (
  select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as signature
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname in(select function_name from required_functions)
    and not exists(
      select 1 from required_functions rf
      where rf.function_name=p.proname and to_regprocedure(rf.signature)=p.oid
    )
),
nullable_blockers as (
  select 'participants.email NOT NULL' as blocker
  from information_schema.columns
  where table_schema='public' and table_name='participants' and column_name='email' and is_nullable='NO'
  union all
  select 'constraint '||con.conname||': '||pg_get_constraintdef(con.oid)
  from pg_constraint con
  where con.conrelid='public.participants'::regclass and con.contype='c'
    and con.conname<>'participants_email_required_chk'
    and (
      lower(pg_get_constraintdef(con.oid)) ~ 'email[^,)]*(is not null|<>|!=)'
      or lower(pg_get_constraintdef(con.oid)) ~ 'phone[^,)]*(is not null|<>|!=)'
    )
),
issue_constraint_conflicts as (
  select con.conname,pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  where con.conrelid='public.participant_data_issues'::regclass and con.contype='u'
    and con.conname<>'participant_data_issues_active_unique'
    and lower(pg_get_constraintdef(con.oid)) like '%participant_id%'
    and lower(pg_get_constraintdef(con.oid)) like '%field_code%'
    and lower(pg_get_constraintdef(con.oid)) like '%issue_type%'
  union all
  select idx.relname,pg_get_indexdef(idx.oid)
  from pg_index i join pg_class idx on idx.oid=i.indexrelid
  where i.indrelid='public.participant_data_issues'::regclass and i.indisunique
    and idx.relname<>'ux_participant_data_issues_open'
    and not exists(select 1 from pg_constraint con where con.conindid=i.indexrelid)
    and lower(pg_get_indexdef(idx.oid)) like '%participant_id%'
    and lower(pg_get_indexdef(idx.oid)) like '%field_code%'
    and lower(pg_get_indexdef(idx.oid)) like '%issue_type%'
),
cpf_base as (
  select p.id,p.event_id,regexp_replace(coalesce(p.cpf,''),'\D','','g') as cpf_digits
  from public.participants p
),
cpf_sums as (
  select b.*,
    (select sum(substring(b.cpf_digits,i,1)::integer*(11-i)) from generate_series(1,9) i) as sum_first,
    (select sum(substring(b.cpf_digits,i,1)::integer*(12-i)) from generate_series(1,10) i) as sum_second
  from cpf_base b where length(b.cpf_digits)=11
),
cpf_evaluation as (
  select b.id,b.event_id,b.cpf_digits,
    case when length(b.cpf_digits)<>11 then false
      when b.cpf_digits=repeat(substring(b.cpf_digits,1,1),11) then false
      else substring(b.cpf_digits,10,1)::integer=
        case when mod(s.sum_first*10,11)=10 then 0 else mod(s.sum_first*10,11) end
        and substring(b.cpf_digits,11,1)::integer=
        case when mod(s.sum_second*10,11)=10 then 0 else mod(s.sum_second*10,11) end
    end as is_valid
  from cpf_base b left join cpf_sums s on s.id=b.id
),
duplicate_cpf_pairs as (
  select event_id,cpf_digits,count(*) as participant_count
  from cpf_evaluation where is_valid
  group by event_id,cpf_digits having count(*)>1
),
duplicate_participants as (
  select c.id from cpf_evaluation c join duplicate_cpf_pairs d
    on d.event_id=c.event_id and d.cpf_digits=c.cpf_digits
),
open_issue_duplicate_groups as (
  select participant_id,coalesce(import_batch_id,'00000000-0000-0000-0000-000000000000'::uuid) as batch_key,
    field_code,issue_type,count(*) as duplicate_count
  from public.participant_data_issues where status='open'
  group by participant_id,coalesce(import_batch_id,'00000000-0000-0000-0000-000000000000'::uuid),field_code,issue_type
  having count(*)>1
),
operator_matches as (
  select count(*)::bigint as total
  from public.import_batches ib join public.import_batch_rows ibr on ibr.import_batch_id=ib.id
  where ib.import_type='current_event_registrations' and ibr.matched_user_id=ib.imported_by
),
identity_conflict_entities as (
  select 'order:'||o.id::text as entity from public.orders o join duplicate_participants d on d.id=o.participant_id
  union
  select 'ticket:'||t.id::text from public.tickets t join duplicate_participants d on d.id=t.participant_id
),
historical_placeholders as (
  select count(*)::bigint as total from public.participants p
  where exists(select 1 from public.participation_history ph where ph.participant_id=p.id and ph.source='import')
    and (
      upper(coalesce(p.cpf,'')) like 'IMPORT%'
      or lower(coalesce(p.email,'')) like '%@importacao.local'
      or regexp_replace(coalesce(p.phone,''),'\D','','g')='00000000000'
      or lower(trim(coalesce(p.shirt_type,'')))='sem camiseta'
      or upper(trim(coalesce(p.shirt_size,'')))='N/A'
    )
),
metrics as (
  select
    (select count(*) from duplicate_cpf_pairs)::bigint as duplicate_cpf_event_pairs,
    (select count(*) from cpf_evaluation where cpf_digits<>'' and not is_valid)::bigint as invalid_cpf_existing_rows,
    (select count(*) from schema_incompatibilities)::bigint as participants_missing_required_schema_compatibility,
    (select count(*) from issue_constraint_conflicts)::bigint as conflicting_issue_constraints,
    (select count(*) from missing_functions)::bigint as missing_required_functions,
    (select count(*) from unexpected_signatures)::bigint as unexpected_function_signatures,
    (select total from operator_matches) as operator_user_matches,
    (select coalesce(sum(duplicate_count-1),0) from open_issue_duplicate_groups)::bigint as open_issue_duplicates,
    (select count(*) from identity_conflict_entities)::bigint as tickets_or_orders_with_identity_conflicts,
    (select count(*) from nullable_blockers)::bigint as nullable_email_phone_blockers,
    (select count(*) from public.import_batches where import_type='current_event_registrations' and status='ready_for_review')::bigint as ready_for_review_batches,
    (select total from historical_placeholders) as imported_participants_with_placeholders,
    (select count(*) from public.participant_data_issues where status='open')::bigint as historical_open_issues
),
summary as (
  select m.*,
    array_remove(array[
      case when duplicate_cpf_event_pairs>0 then duplicate_cpf_event_pairs||' CPF(s) valido(s) duplicado(s) no mesmo evento impedem identidade deterministica.' end,
      case when participants_missing_required_schema_compatibility>0 then participants_missing_required_schema_compatibility||' coluna(s) obrigatoria(s) ausente(s) ou com tipo incompatível.' end,
      case when nullable_email_phone_blockers>0 then nullable_email_phone_blockers||' definicao(oes) adicional(is) impedem email/telefone nulos.' end,
      case when conflicting_issue_constraints>0 then conflicting_issue_constraints||' constraint(s) de pendencia nao removida(s) pela 094 conflitam com o novo indice.' end,
      case when missing_required_functions>0 then missing_required_functions||' funcao(oes) exigida(s) pela 094 nao existem com a assinatura esperada.' end,
      case when unexpected_function_signatures>0 then unexpected_function_signatures||' overload(s)/assinatura(s) inesperada(s) exigem revisao antes da 094.' end,
      case when open_issue_duplicates>0 then open_issue_duplicates||' pendencia(s) aberta(s) duplicada(s) impedem o novo indice unico.' end,
      case when tickets_or_orders_with_identity_conflicts>0 then tickets_or_orders_with_identity_conflicts||' pedido(s)/ticket(s) dependem de participants com CPF duplicado.' end
    ],null)::text[] as blocking_reasons,
    array_remove(array[
      case when operator_user_matches>0 then operator_user_matches||' linha(s) antigas possuem matched_user_id igual ao operador; a 094 nao usa esse campo como identidade e o zera no upsert.' end,
      case when ready_for_review_batches>0 then ready_for_review_batches||' lote(s) atuais aguardam revisao.' end,
      case when imported_participants_with_placeholders>0 then imported_participants_with_placeholders||' participant(s) antigos possuem placeholders legados.' end,
      case when invalid_cpf_existing_rows>0 then invalid_cpf_existing_rows||' participant(s) possuem CPF historico invalido; nao serao usados como chave automatica.' end,
      case when historical_open_issues>0 then historical_open_issues||' pendencia(s) antigas permanecem abertas.' end
    ],null)::text[] as non_blocking_notes
  from metrics m
)
select cardinality(blocking_reasons)=0 as safe_to_apply,
  blocking_reasons,non_blocking_notes,
  (select coalesce(jsonb_agg(jsonb_build_object(
      'table',d.table_name,
      'expected_column',d.expected_column,
      'expected_type',d.expected_type,
      'expected_nullable',d.expected_nullable,
      'exists',d."exists",
      'actual_type',d.actual_type,
      'actual_nullable',d.actual_nullable,
      'status',d.status
    ) order by d.table_name,d.expected_column),'[]'::jsonb)
   from schema_compatibility_diagnostic d
   where d.status<>'compatible') as schema_incompatibility_details,
  duplicate_cpf_event_pairs,invalid_cpf_existing_rows,
  participants_missing_required_schema_compatibility,conflicting_issue_constraints,
  missing_required_functions,unexpected_function_signatures,operator_user_matches,
  open_issue_duplicates,tickets_or_orders_with_identity_conflicts,
  nullable_email_phone_blockers,ready_for_review_batches,
  imported_participants_with_placeholders,historical_open_issues
from summary;
