-- 104_event_shirt_supply_mode_preflight.sql
-- Estritamente somente leitura: valida o plano explicito antes ou depois da migration.

with explicit_classification_plan(event_id,kit_item_id,supply_mode) as (
  values(
    '6c931940-03ad-48c2-836c-754924a00d00'::uuid,
    '2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,
    'made_to_order'::text
  )
), explicit_variant_plan(kit_item_id,shirt_type,shirt_size,sort_order) as (
  values
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','PP',10),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','P',20),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','M',30),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','G',40),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','GG',50),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','EG',60),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','EXG',70),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Camiseta','EXGG',80),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Babylook','PP',110),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Babylook','P',120),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Babylook','M',130),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Babylook','G',140),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Babylook','GG',150),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Babylook','EG',160),
    ('2b6aa3a1-3453-4486-9c6c-658e883fc209'::uuid,'Babylook','EXG',170)
), structure as (
  select to_regclass('public.event_kit_items') is not null has_event_kit_items,
    to_regclass('public.event_kit_item_variants') is not null has_variants,
    to_regclass('public.event_kit_item_variant_inventory') is not null has_variant_inventory,
    to_regclass('public.participant_kit_items') is not null has_participant_kit_items,
    to_regclass('public.organizations') is not null has_organizations,
    to_regprocedure('public.current_user_has_permission(text)') is not null has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null has_organization_guard
), plan_validation as (
  select count(*)::integer planned_classification_count,
    count(distinct (event_id,kit_item_id))::integer distinct_planned_target_count,
    count(*) filter(where supply_mode not in('stock','made_to_order','disabled'))::integer invalid_planned_mode_count
  from explicit_classification_plan
), variant_plan_validation as (
  select count(*)::integer planned_enabled_variant_count,
    count(distinct (kit_item_id,shirt_type,shirt_size))::integer distinct_planned_variant_count,
    count(*) filter(where nullif(trim(shirt_type),'') is null or nullif(trim(shirt_size),'') is null)::integer invalid_planned_variant_count
  from explicit_variant_plan
), target_validation as (
  select count(eki.id)::integer matched_target_count,
    count(*) filter(where e.name='Militrin 2026' and e.organization_id is not null and o.id=e.organization_id
      and eki.event_id=p.event_id and eki.item_type='shirt' and eki.is_active)::integer expected_target_count,
    count(distinct e.organization_id)::integer matched_organization_count
  from explicit_classification_plan p
  left join public.events e on e.id=p.event_id
  left join public.organizations o on o.id=e.organization_id
  left join public.event_kit_items eki on eki.id=p.kit_item_id
), active_shirts as (
  select eki.id kit_item_id,eki.event_id,
    nullif(to_jsonb(eki)->>'shirt_supply_mode','') current_supply_mode,
    (select count(*) from explicit_classification_plan p where p.event_id=eki.event_id and p.kit_item_id=eki.id)::integer plan_coverage_count
  from public.event_kit_items eki where eki.item_type='shirt' and eki.is_active
), coverage as (
  select count(*) filter(where current_supply_mode is null)::integer unclassified_active_shirt_count,
    count(*) filter(where current_supply_mode is null and plan_coverage_count=1)::integer unclassified_items_covered_by_plan_count,
    count(*) filter(where current_supply_mode is null and plan_coverage_count<>1)::integer uncovered_unclassified_count,
    count(*) filter(where current_supply_mode is not null and current_supply_mode not in('stock','made_to_order','disabled'))::integer invalid_installed_mode_count,
    count(*) filter(where plan_coverage_count>1)::integer multiply_covered_active_item_count,
    coalesce(jsonb_agg(jsonb_build_object('event_id',event_id,'kit_item_id',kit_item_id,
      'current_supply_mode',current_supply_mode,'plan_coverage_count',plan_coverage_count)
      order by event_id,kit_item_id),'[]'::jsonb) as active_shirt_events
  from active_shirts
), installed_classifications as (
  select count(distinct eki.id) filter(
    where nullif(to_jsonb(eki)->>'shirt_supply_mode','')=p.supply_mode
  )::integer installed_classification_count
  from explicit_classification_plan p
  left join public.event_kit_items eki on eki.id=p.kit_item_id and eki.event_id=p.event_id
), installed_variants as (
  select
    count(distinct v.id) filter(
      where v.is_active
        and exists(select 1 from explicit_variant_plan vp
          where vp.kit_item_id=v.kit_item_id and vp.shirt_type=v.name and vp.shirt_size=v.value)
    )::integer installed_planned_variant_count,
    count(distinct v.id) filter(
      where v.is_active
        and not exists(select 1 from explicit_variant_plan vp
          where vp.kit_item_id=v.kit_item_id and vp.shirt_type=v.name and vp.shirt_size=v.value)
    )::integer unexpected_enabled_variant_count
  from explicit_classification_plan p
  left join public.event_kit_item_variants v on v.kit_item_id=p.kit_item_id
), duplicate_database_variant_keys as (
  select v.kit_item_id,v.name,v.value
  from public.event_kit_item_variants v
  join explicit_variant_plan vp
    on vp.kit_item_id=v.kit_item_id and vp.shirt_type=v.name and vp.shirt_size=v.value
  group by v.kit_item_id,v.name,v.value
  having count(distinct v.id)>1
), installed_duplicate_state as (
  select count(*)::integer duplicate_database_planned_variant_count
  from duplicate_database_variant_keys
), installed_state as (
  select ic.installed_classification_count,iv.installed_planned_variant_count,
    iv.unexpected_enabled_variant_count,ids.duplicate_database_planned_variant_count
  from installed_classifications ic cross join installed_variants iv cross join installed_duplicate_state ids
)
select s.*,pv.planned_classification_count,vpv.planned_enabled_variant_count,
  c.unclassified_active_shirt_count,c.unclassified_items_covered_by_plan_count,c.uncovered_unclassified_count,
  c.invalid_installed_mode_count,c.multiply_covered_active_item_count,c.active_shirt_events,
  coalesce(i.installed_classification_count,0) installed_classification_count,
  coalesce(i.installed_planned_variant_count,0) installed_planned_variant_count,
  coalesce(i.unexpected_enabled_variant_count,0) unexpected_enabled_variant_count,
  coalesce(i.duplicate_database_planned_variant_count,0) duplicate_database_planned_variant_count,
  tv.matched_target_count=1 and tv.expected_target_count=1 and tv.matched_organization_count=1 as plan_matches_database_target,
  coalesce(i.installed_classification_count,0)=pv.planned_classification_count
    and coalesce(i.installed_planned_variant_count,0)=vpv.planned_enabled_variant_count
    and coalesce(i.unexpected_enabled_variant_count,0)=0 as idempotent_state_installed,
  s.has_event_kit_items and s.has_variants and s.has_variant_inventory and s.has_participant_kit_items and s.has_organizations
    and s.has_permission_resolver and s.has_organization_guard
    and pv.planned_classification_count=1 and pv.distinct_planned_target_count=pv.planned_classification_count and pv.invalid_planned_mode_count=0
    and vpv.planned_enabled_variant_count=15 and vpv.distinct_planned_variant_count=vpv.planned_enabled_variant_count and vpv.invalid_planned_variant_count=0
    and tv.matched_target_count=1 and tv.expected_target_count=1 and tv.matched_organization_count=1
    and c.uncovered_unclassified_count=0 and c.multiply_covered_active_item_count=0 and c.invalid_installed_mode_count=0
    and coalesce(i.duplicate_database_planned_variant_count,0)=0
    and (c.unclassified_items_covered_by_plan_count=1 or coalesce(i.installed_classification_count,0)=1)
  as safe_to_apply
from structure s cross join plan_validation pv cross join variant_plan_validation vpv
cross join target_validation tv cross join coverage c left join installed_state i on true;
