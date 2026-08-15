-- 143_administrative_ticket_manual_candidates.sql
-- SELECT-only. Identifica dados deterministicos para os testes controlados da 143.

with event_context as (
  select e.id as event_id,e.organization_id,e.name as event_name
  from public.events e
  where e.id='6c931940-03ad-48c2-836c-754924a00d00'
), contacts as (
  select rc.id as registration_contact_id,rc.full_name,rc.gender,
    count(distinct p.user_id) filter(where p.user_id is not null and au.id is not null)::integer as account_count,
    (array_agg(distinct p.user_id order by p.user_id)
      filter(where p.user_id is not null and au.id is not null))[1] as account_user_id,
    public.registration_contact_has_active_ticket(e.event_id,rc.id,null) as has_active_ticket
  from event_context e
  join public.registration_contacts rc on rc.organization_id=e.organization_id
  left join public.participants p on p.organization_id=rc.organization_id
    and p.registration_contact_id=rc.id
  left join auth.users au on au.id=p.user_id
  group by rc.id,rc.full_name,rc.gender,e.event_id
), candidate_contacts as (
  select * from contacts
  where registration_contact_id='c90ed570-a2f3-4601-b076-bcc18714075f'
    or (not has_active_ticket and account_count in(0,1))
  order by case when registration_contact_id='c90ed570-a2f3-4601-b076-bcc18714075f' then 0 else 1 end,
    account_count desc,full_name
  limit 30
)
select jsonb_build_object(
  'contacts',(select jsonb_agg(to_jsonb(c) order by
    case when c.registration_contact_id='c90ed570-a2f3-4601-b076-bcc18714075f' then 0 else 1 end,
    c.account_count desc,c.full_name) from candidate_contacts c),
  'categories',(select jsonb_agg(to_jsonb(tc) order by tc.created_at,tc.id)
    from public.ticket_categories tc where tc.event_id='6c931940-03ad-48c2-836c-754924a00d00'),
  'batches',(select jsonb_agg(jsonb_build_object(
      'batch_id',rb.id,'name',rb.name,'is_active',rb.is_active,'starts_at',rb.starts_at,'ends_at',rb.ends_at,
      'ticket_category_id',rbp.ticket_category_id,'male_price',rbp.male_price,'female_price',rbp.female_price)
      order by rb.is_active desc,rb.sequence_number,rb.id,rbp.ticket_category_id)
    from public.registration_batches rb join public.registration_batch_prices rbp on rbp.batch_id=rb.id
    where rb.event_id='6c931940-03ad-48c2-836c-754924a00d00'),
  'shirt_variants',(select jsonb_agg(jsonb_build_object(
      'kit_item_id',eki.id,'kit_item_name',eki.name,'shirt_supply_mode',eki.shirt_supply_mode,
      'variant_id',v.id,'shirt_type',v.name,'shirt_size',v.value)
      order by eki.sort_order,v.name,v.value,v.id)
    from public.event_kit_items eki join public.event_kit_item_variants v on v.kit_item_id=eki.id and v.is_active
    where eki.event_id='6c931940-03ad-48c2-836c-754924a00d00' and eki.item_type='shirt' and eki.is_active)
) as candidates;
