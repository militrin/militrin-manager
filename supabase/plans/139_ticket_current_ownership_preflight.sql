-- 139_ticket_current_ownership_preflight.sql
-- SELECT-only. Classifica a origem deterministica (ou ausencia) do proprietario atual.

with ticket_ownership_preflight as (
  select
    t.id as ticket_id,
    t.organization_id as ticket_organization_id,
    t.order_id,
    o.organization_id as order_organization_id,
    o.buyer_type,
    o.user_id as buyer_user_id,
    case
      when o.id is null then 'order_missing'
      when t.organization_id is distinct from o.organization_id then 'organization_inconsistent'
      when o.buyer_type = 'imported_holder' and o.user_id is null then 'imported_without_account'
      when o.buyer_type = 'account' and o.user_id is null then 'account_order_without_buyer'
      when o.buyer_type = 'account' and au.id is null then 'buyer_account_missing'
      when o.buyer_type = 'account' and au.id is not null then 'deterministic_account_buyer'
      when o.user_id is null then 'order_without_buyer'
      else 'ambiguous_buyer_type'
    end as classification,
    case
      when o.buyer_type = 'account'
       and o.user_id is not null
       and au.id is not null
       and t.organization_id = o.organization_id
      then o.user_id
      else null
    end as deterministic_owner_user_id
  from public.tickets t
  left join public.orders o on o.id = t.order_id
  left join auth.users au on au.id = o.user_id
)
select *
from ticket_ownership_preflight
order by classification, ticket_id;

with ticket_ownership_preflight as (
  select
    t.id,
    case
      when o.id is null then 'order_missing'
      when t.organization_id is distinct from o.organization_id then 'organization_inconsistent'
      when o.buyer_type = 'imported_holder' and o.user_id is null then 'imported_without_account'
      when o.buyer_type = 'account' and o.user_id is null then 'account_order_without_buyer'
      when o.buyer_type = 'account' and au.id is null then 'buyer_account_missing'
      when o.buyer_type = 'account' and au.id is not null then 'deterministic_account_buyer'
      when o.user_id is null then 'order_without_buyer'
      else 'ambiguous_buyer_type'
    end as classification
  from public.tickets t
  left join public.orders o on o.id = t.order_id
  left join auth.users au on au.id = o.user_id
)
select classification, count(*) as ticket_count
from ticket_ownership_preflight
group by classification
order by classification;

-- Vinculos conta -> cadastro usados somente pela opcao assign_new_owner.
-- Mais de um cadastro por conta/organizacao e ambiguo e deve bloquear essa opcao.
select
  p.organization_id,
  p.user_id,
  count(distinct p.registration_contact_id) as registration_contact_count,
  array_agg(distinct p.registration_contact_id order by p.registration_contact_id) as registration_contact_ids
from public.participants p
where p.user_id is not null and p.registration_contact_id is not null
group by p.organization_id, p.user_id
having count(distinct p.registration_contact_id) > 1
order by p.organization_id, p.user_id;
