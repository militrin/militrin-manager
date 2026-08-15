-- 090_separate_contacts_from_ticket_issuance.sql
-- Separa cadastro organizacional de participante/evento e permite ingresso sem titular.

begin;

create table if not exists public.registration_contacts(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null,
  cpf text not null,
  birth_date date not null,
  gender text,
  phone text not null,
  email text not null,
  city text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_registration_contacts_org_cpf
  on public.registration_contacts(organization_id,cpf);
create index if not exists idx_registration_contacts_org_name
  on public.registration_contacts(organization_id,full_name);

alter table public.registration_contacts enable row level security;
drop policy if exists registration_contacts_org_select on public.registration_contacts;
create policy registration_contacts_org_select on public.registration_contacts for select
  using(public.user_can_access_organization(auth.uid(),organization_id));

alter table public.participants add column if not exists registration_contact_id uuid
  references public.registration_contacts(id) on delete set null;
alter table public.order_items add column if not exists registration_contact_id uuid
  references public.registration_contacts(id) on delete set null;

alter table public.orders alter column participant_id drop not null;
alter table public.payments alter column participant_id drop not null;

create or replace function public.create_registration_contact(
  p_organization_id uuid,p_full_name text,p_cpf text,p_birth_date date,
  p_gender text,p_phone text,p_email text,p_city text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_cpf text:=regexp_replace(coalesce(p_cpf,''),'\D','','g');
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para criar cadastro.'; end if;
  if not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if length(v_cpf)<>11 or nullif(trim(p_full_name),'') is null or p_birth_date is null then raise exception 'Dados cadastrais invalidos.'; end if;
  insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city,created_by)
  values(p_organization_id,trim(p_full_name),v_cpf,p_birth_date,nullif(trim(coalesce(p_gender,'')),''),
    regexp_replace(coalesce(p_phone,''),'\D','','g'),lower(trim(p_email)),nullif(trim(coalesce(p_city,'')),''),v_actor)
  on conflict(organization_id,cpf) do update set full_name=excluded.full_name,birth_date=excluded.birth_date,
    gender=excluded.gender,phone=excluded.phone,email=excluded.email,city=excluded.city,updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;

revoke all on function public.create_registration_contact(uuid,text,text,date,text,text,text,text) from public,anon,authenticated;
grant execute on function public.create_registration_contact(uuid,text,text,date,text,text,text,text) to authenticated;

create or replace function public.create_manual_unassigned_ticket_order(
  p_event_id uuid,p_ticket_category_id uuid,p_pricing_gender text,p_shirt_type text,p_shirt_size text,
  p_payment_method text,p_coupon_code text default null,p_notes text default null
) returns table(order_id uuid,order_item_id uuid,payment_id uuid,ticket_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_pricing record;
  v_order_id uuid; v_item_id uuid; v_payment_id uuid; v_ticket_id uuid;
  v_paid boolean:=lower(trim(coalesce(p_payment_method,'')))='courtesy'; v_expires timestamptz;
  v_inventory public.shirt_inventory%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para emitir ingresso.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=p_event_id and is_active) then raise exception 'Categoria invalida para o evento.'; end if;
  select * into v_pricing from public.get_registration_pricing_preview(p_pricing_gender,nullif(trim(coalesce(p_coupon_code,'')),''),p_event_id,p_ticket_category_id) limit 1;
  if v_pricing.batch_id is null then raise exception 'Lote/preco nao configurado.'; end if;
  v_expires:=case when v_paid then null else now()+interval '2 hours' end;
  insert into public.orders(user_id,participant_id,event_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
  values(v_actor,null,p_event_id,public.generate_order_number(),case when v_paid then 'confirmed' else 'pending' end,
    v_pricing.base_amount,v_pricing.discount_amount,v_pricing.final_amount,'account',case when v_paid then now() end) returning id into v_order_id;
  insert into public.order_items(order_id,event_id,participant_id,ownership_status,ticket_category_id,batch_id,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status,reservation_expires_at,notes)
  values(v_order_id,p_event_id,null,'unassigned',p_ticket_category_id,v_pricing.batch_id,nullif(trim(coalesce(p_shirt_type,'')),''),
    nullif(trim(coalesce(p_shirt_size,'')),''),1,v_pricing.base_amount,v_pricing.discount_amount,v_pricing.final_amount,
    case when v_paid then 'confirmed' else 'reserved' end,v_expires,nullif(trim(coalesce(p_notes,'')),'')) returning id into v_item_id;
  if nullif(trim(coalesce(p_shirt_type,'')),'') is not null and nullif(trim(coalesce(p_shirt_size,'')),'') is not null then
    select * into v_inventory from public.shirt_inventory
    where event_id=p_event_id and shirt_type=p_shirt_type and shirt_size=p_shirt_size for update;
    if not found or v_inventory.total_quantity-v_inventory.reserved_quantity-v_inventory.delivered_quantity<1 then
      raise exception 'Estoque indisponivel para o modelo/tamanho selecionado.';
    end if;
    update public.shirt_inventory set reserved_quantity=reserved_quantity+1,updated_at=now() where id=v_inventory.id;
  end if;
  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at,expires_at)
  values(null,p_event_id,v_event.organization_id,v_order_id,v_pricing.base_amount,v_pricing.discount_amount,v_pricing.final_amount,
    lower(trim(p_payment_method)),case when v_paid then 'paid' else 'pending' end,case when v_paid then now() end,v_expires) returning id into v_payment_id;
  update public.orders set payment_id=v_payment_id where id=v_order_id;
  if v_paid then v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item_id); end if;
  return query select v_order_id,v_item_id,v_payment_id,v_ticket_id;
end; $$;

revoke all on function public.create_manual_unassigned_ticket_order(uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.create_manual_unassigned_ticket_order(uuid,uuid,text,text,text,text,text,text) to authenticated;

commit;
