-- 093_user_pin_ticket_holder_transfer_preflight.sql
-- Preflight somente leitura para 093_user_pin_ticket_holder_transfer.sql.
-- Execute cada consulta no banco-alvo antes de aplicar a migration 093.

-- 1. CUSTOMER_PROFILES: volume, vínculos e dados necessários à projeção.
select
  count(*) as total_customer_profiles,
  count(user_id) as with_user_id,
  count(*) filter (where user_id is null) as without_user_id,
  count(*) filter (where nullif(trim(full_name), '') is null) as without_full_name
from public.customer_profiles;

select column_name,data_type,is_nullable,column_default
from information_schema.columns
where table_schema='public' and table_name='customer_profiles'
order by ordinal_position;

with required(column_name,purpose) as (values
  ('user_id','identity link'),('full_name','target confirmation and participant projection'),
  ('cpf','participant projection'),('birth_date','participant projection'),
  ('gender','pricing and item validation'),('phone','participant projection'),
  ('city','participant projection'),
  ('account_status','PIN lookup eligibility')
)
select r.column_name,r.purpose,(c.column_name is not null) as exists_in_current_schema
from required r left join information_schema.columns c
  on c.table_schema='public' and c.table_name='customer_profiles' and c.column_name=r.column_name
order by r.column_name;

select 'user_id' as duplicate_key,user_id::text as normalized_value,
  count(*) as profile_count,array_agg(user_id order by user_id) as user_ids
from public.customer_profiles
where user_id is not null
group by user_id having count(*)>1
order by duplicate_key, normalized_value;

select c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='customer_profiles';

select policyname,permissive,roles,cmd,qual,with_check
from pg_policies where schemaname='public' and tablename='customer_profiles'
order by cmd,policyname;

select
  count(*) filter (where cmd='SELECT') as select_policy_count,
  count(*) filter (
    where cmd='SELECT' and ('authenticated'=any(roles) or 'public'=any(roles))
      and coalesce(qual,'') not ilike '%auth.uid()%'
      and coalesce(qual,'') not ilike '%user_can_access_organization%'
      and coalesce(qual,'') not ilike '%is_platform_%'
  ) as potentially_broad_authenticated_select_policies,
  case when count(*) filter (
    where cmd='SELECT' and ('authenticated'=any(roles) or 'public'=any(roles))
      and coalesce(qual,'') not ilike '%auth.uid()%'
      and coalesce(qual,'') not ilike '%user_can_access_organization%'
      and coalesce(qual,'') not ilike '%is_platform_%'
  )=0 then 'No broad SELECT policy detected heuristically; public_pin remains protected by owner/admin RLS.'
  else 'REVIEW_REQUIRED: a SELECT policy may expose every customer_profiles column, including future public_pin.' end as public_pin_generic_select_assessment
from pg_policies where schemaname='public' and tablename='customer_profiles';

-- 2. PIN: conceitos equivalentes e dependências criptográficas.
select table_schema,table_name,column_name,data_type
from information_schema.columns
where table_schema in('public','auth')
  and column_name ~* '(^|_)(pin|user_code|member_code|public_code|account_code)($|_)'
order by table_schema,table_name,column_name;

select
  exists(select 1 from pg_extension where extname='pgcrypto') as pgcrypto_installed,
  to_regprocedure('gen_random_bytes(integer)') is not null as gen_random_bytes_available,
  (select count(*) from public.customer_profiles) as profiles_requiring_backfill,
  '10 uppercase hexadecimal characters from 5 cryptographically random bytes' as planned_pin_format,
  'UNIQUE partial index before backfill, then NOT NULL' as planned_uniqueness,
  'No CPF, email, phone or UUID input is used by the generator' as personal_data_independence,
  'Generator serializes allocation with a transaction advisory lock; backfill retries unique_violation explicitly and the unique index is authoritative.' as collision_retry_assessment;

-- 3. PARTICIPANT PROJECTION: vínculo atual e ambiguidades por usuário/evento.
select
  count(*) as participants_linked_to_profiles,
  count(distinct p.user_id) as linked_users,
  count(distinct (p.user_id,p.event_id)) as linked_user_event_pairs
from public.participants p join public.customer_profiles cp on cp.user_id=p.user_id
where p.user_id is not null;

select p.user_id,p.event_id,count(*) as participant_count,
  cp.full_name as customer_profile_name,
  jsonb_agg(jsonb_build_object(
    'participant_id',p.id,
    'full_name',p.full_name,
    'registration_status',p.registration_status,
    'created_at',p.created_at
  ) order by p.created_at,p.id) as participants_involved
from public.participants p join public.customer_profiles cp on cp.user_id=p.user_id
where p.user_id is not null and p.event_id is not null
group by p.user_id,p.event_id,cp.full_name having count(*)>1
order by participant_count desc,p.user_id,p.event_id;

select
  count(*) as ambiguous_user_event_pairs,
  coalesce(sum(participant_count),0) as participants_in_ambiguous_pairs
from (
  select p.user_id,p.event_id,count(*) as participant_count
  from public.participants p join public.customer_profiles cp on cp.user_id=p.user_id
  where p.user_id is not null and p.event_id is not null
  group by p.user_id,p.event_id having count(*)>1
) ambiguous;

-- 4. TICKETS: nulabilidade, chaves operacionais e invariantes.
select
  count(*) as total_tickets,
  count(*) filter(where participant_id is not null) as with_participant,
  count(*) filter(where participant_id is null) as without_participant,
  count(*) filter(where order_item_id is not null) as with_order_item,
  count(*) filter(where order_item_id is null) as without_order_item,
  count(*) filter(where order_id is null) as without_order
from public.tickets;

select column_name,is_nullable,data_type
from information_schema.columns
where table_schema='public' and table_name='tickets' and column_name in('id','token','participant_id','order_id','order_item_id','event_id','organization_id')
order by column_name;

select
  count(*) filter(where oi.id is null) as ticket_order_item_missing,
  count(*) filter(where o.id is null) as ticket_order_missing,
  count(*) filter(where oi.id is not null and oi.order_id is distinct from t.order_id) as order_mismatch,
  count(*) filter(where oi.id is not null and oi.event_id is distinct from t.event_id) as event_mismatch,
  count(*) filter(where oi.id is not null and oi.participant_id is distinct from t.participant_id) as participant_mismatch
from public.tickets t
left join public.order_items oi on oi.id=t.order_item_id
left join public.orders o on o.id=t.order_id;

select order_item_id,count(*) as ticket_count,array_agg(id order by id) as ticket_ids
from public.tickets where order_item_id is not null
group by order_item_id having count(*)>1 order by ticket_count desc,order_item_id;

-- 5. COMPRADOR: colunas que a operação deve manter imutáveis.
select
  count(*) as tickets_with_buyer_snapshot,
  count(*) filter(where o.user_id is null) as orders_without_buyer_user,
  count(*) filter(where o.buyer_type is null) as orders_without_buyer_type,
  count(*) filter(where t.order_id is distinct from oi.order_id) as ticket_item_order_mismatch,
  '093 must only change order_items.participant_id/holder fields and tickets.participant_id/ownership_status' as immutable_buyer_contract
from public.tickets t
join public.orders o on o.id=t.order_id
left join public.order_items oi on oi.id=t.order_item_id;

select count(*) as payments_linked_to_ticket_orders
from public.payments p where p.order_id in(select distinct order_id from public.tickets where order_id is not null);

-- 6. PRIVACIDADE: conflitos preexistentes e propriedades das RPCs, caso já existam.
with expected(proname) as (values
  ('get_my_public_pin'),('find_user_by_public_pin'),('define_ticket_holder_by_pin'),
  ('transfer_ticket_by_pin'),('admin_transfer_ticket_by_pin'),('change_ticket_holder_by_pin_internal'),
  ('set_event_ticket_holder_rules')
)
select e.proname as expected_function,
  p.oid is not null as already_exists,
  coalesce(p.prosecdef,false) as security_definer,
  coalesce(array_to_string(p.proconfig,','),'') as function_config,
  case when p.oid is null then 'Absent as expected before migration 093.'
       when not p.prosecdef then 'REVIEW_REQUIRED: function is not SECURITY DEFINER.'
       when coalesce(array_to_string(p.proconfig,','),'') not ilike '%search_path=public, pg_temp%'
        and coalesce(array_to_string(p.proconfig,','),'') not ilike '%search_path=public,pg_temp%'
       then 'REVIEW_REQUIRED: fixed search_path not detected.' else 'Existing definition has expected security posture.' end as assessment
from expected e left join pg_proc p on p.proname=e.proname and p.pronamespace='public'::regnamespace
order by e.proname;

select
  'find_user_by_public_pin' as planned_lookup,
  'ticket-scoped and exact normalized PIN only' as matching,
  'full_name only' as returned_fields,
  1 as maximum_rows,
  '15 authenticated attempts per 10 minutes' as rate_limit,
  'Lookup requires access to the supplied ticket and does not echo the submitted PIN.' as privacy_note;

-- 7. TITULARIDADE: histórico append-only e estado operacional que não pode mudar.
select
  count(*) filter(where t.participant_id is null) as eligible_for_holder_assignment_by_state,
  count(*) filter(where t.participant_id is not null) as eligible_for_transfer_by_state,
  count(*) filter(where t.token is null) as tickets_without_token,
  count(*) filter(where t.used_at is not null) as tickets_already_checked_in,
  count(*) filter(where exists(select 1 from public.participant_kit_items pki where pki.ticket_id=t.id)) as tickets_with_kit_items
from public.tickets t;

select
  to_regclass('public.ticket_holder_history') is not null as history_table_already_exists,
  'Planned history allows SELECT only through RLS; writes occur only inside SECURITY DEFINER operations.' as append_only_contract,
  'ticket id, token, order id, order buyer, payments, kit rows and check-in timestamps must remain unchanged' as immutable_operational_contract;

-- 8. GÊNERO: tickets que exigem decisão segura, sem correção automática.
select t.id as ticket_id,t.event_id,t.order_item_id,oi.participant_id,oi.ticket_category_id,oi.batch_id,
  oi.unit_price,rbp.male_price,rbp.female_price,p.gender as current_holder_gender,
  case when rbp.male_price is distinct from rbp.female_price then 'gender_dependent_price' end as pricing_risk,
  case when nullif(trim(oi.shirt_type),'') is not null then 'shirt_requires_review_on_gender_change' end as item_risk
from public.tickets t
join public.order_items oi on oi.id=t.order_item_id
left join public.participants p on p.id=oi.participant_id
left join public.registration_batch_prices rbp on rbp.batch_id=oi.batch_id and rbp.ticket_category_id=oi.ticket_category_id
where rbp.male_price is distinct from rbp.female_price or nullif(trim(oi.shirt_type),'') is not null
order by t.event_id,t.id;

select
  count(*) filter(where rbp.male_price is distinct from rbp.female_price) as tickets_with_gender_dependent_price,
  count(*) filter(where nullif(trim(oi.shirt_type),'') is not null) as tickets_with_shirt_selection,
  count(*) filter(where (rbp.male_price is distinct from rbp.female_price or nullif(trim(oi.shirt_type),'') is not null)
    and nullif(trim(coalesce(p.gender,'')),'') is null) as risky_tickets_without_current_gender,
  (select count(*) from public.customer_profiles where nullif(trim(coalesce(gender,'')),'') is null) as target_profiles_without_gender
from public.tickets t join public.order_items oi on oi.id=t.order_item_id
left join public.participants p on p.id=oi.participant_id
left join public.registration_batch_prices rbp on rbp.batch_id=oi.batch_id and rbp.ticket_category_id=oi.ticket_category_id;

-- 9. ADMIN: funções e permissões das quais o override planejado depende.
select
  to_regprocedure('user_can_access_organization(uuid,uuid)') is not null as organization_guard_exists,
  to_regprocedure('current_user_has_permission(text)') is not null as permission_guard_exists,
  exists(select 1 from public.admin_permissions where code='participants.edit_basic' and is_active) as admin_permission_exists,
  to_regclass('public.audit_logs') is not null as audit_table_exists,
  'Override must require organization access + participants.edit_basic and record actor_origin=admin with reason.' as override_contract;

-- 10. RESULTADO FINAL.
with metrics as (
  select
    (select count(*) from public.customer_profiles) as profiles,
    (select count(*) from public.customer_profiles where user_id is null) as profiles_without_user,
    (select count(*) from (
      select p.user_id,p.event_id from public.participants p join public.customer_profiles cp on cp.user_id=p.user_id
      where p.user_id is not null and p.event_id is not null group by p.user_id,p.event_id having count(*)>1
    ) a) as ambiguous_participant_pairs,
    (select count(*) from public.tickets where order_item_id is null) as tickets_without_order_item,
    (select count(*) from public.tickets t join public.order_items oi on oi.id=t.order_item_id
      where oi.order_id is distinct from t.order_id or oi.event_id is distinct from t.event_id or oi.participant_id is distinct from t.participant_id) as ticket_invariant_mismatches,
    not exists(select 1 from pg_extension where extname='pgcrypto') or to_regprocedure('gen_random_bytes(integer)') is null as crypto_missing,
    (select count(*) from pg_policies where schemaname='public' and tablename='customer_profiles' and cmd='SELECT'
      and ('authenticated'=any(roles) or 'public'=any(roles)) and coalesce(qual,'') not ilike '%auth.uid()%'
      and coalesce(qual,'') not ilike '%user_can_access_organization%' and coalesce(qual,'') not ilike '%is_platform_%') as broad_profile_policies,
    (select count(*) from information_schema.columns where table_schema in('public','auth')
      and column_name ~* '(^|_)(pin|user_code|member_code|public_code|account_code)($|_)') as equivalent_pin_columns,
    (select count(*) from (values('user_id'),('full_name'),('cpf'),('birth_date'),('gender'),('phone'),('city'),('account_status')) required(column_name)
      where not exists(select 1 from information_schema.columns c where c.table_schema='public'
        and c.table_name='customer_profiles' and c.column_name=required.column_name)) as missing_profile_columns_required_by_093
), result as (
  select *,array_remove(array[
    case when profiles_without_user>0 then 'customer_profiles_without_user_id' end,
    case when ambiguous_participant_pairs>0 then 'ambiguous_participants_for_same_user_and_event' end,
    case when tickets_without_order_item>0 then 'tickets_without_order_item_id' end,
    case when ticket_invariant_mismatches>0 then 'ticket_order_item_invariant_mismatch' end,
    case when crypto_missing then 'pgcrypto_or_gen_random_bytes_missing' end,
    case when broad_profile_policies>0 then 'customer_profiles_select_policy_may_expose_future_public_pin' end,
    case when equivalent_pin_columns>0 then 'equivalent_pin_or_user_code_already_exists' end,
    case when missing_profile_columns_required_by_093>0 then 'customer_profiles_missing_columns_required_by_migration_093' end
  ],null) as blocking_reasons,
  array[
    'Lookup is exact, rate-limited, ticket-scoped and returns only the confirmation name.',
    'New participant projections obtain account email from auth.users instead of customer_profiles.',
    'Gender-sensitive tickets are listed above and require no automatic correction.',
    'Buyer, order, payment, QR, kit and check-in invariants must be regression-tested after review.'
  ]::text[] as non_blocking_notes from metrics
)
select cardinality(blocking_reasons)=0 as safe_to_apply,blocking_reasons,non_blocking_notes,
  profiles,profiles_without_user,ambiguous_participant_pairs,tickets_without_order_item,
  ticket_invariant_mismatches,crypto_missing,broad_profile_policies,equivalent_pin_columns,
  missing_profile_columns_required_by_093
from result;
