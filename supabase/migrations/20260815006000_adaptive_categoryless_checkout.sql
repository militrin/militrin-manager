-- Checkout adaptativo: eventos sem categorias elegiveis operam com ingresso unico.
begin;

alter function public.get_registration_pricing_preview(text,text,uuid,uuid)
  rename to get_registration_pricing_preview_categorized_legacy;

revoke all on function public.get_registration_pricing_preview_categorized_legacy(text,text,uuid,uuid)
  from public,anon,authenticated;

create or replace function public.get_registration_pricing_preview(
  p_gender text,p_coupon_code text default null,p_event_id uuid default null,p_ticket_category_id uuid default null
) returns table(batch_id uuid,batch_name text,sequence_number integer,base_amount numeric,discount_amount numeric,
  final_amount numeric,remaining_slots integer,coupon_message text,coupon_type text,discount_percent numeric)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event_id uuid:=p_event_id; v_batch public.registration_batches%rowtype; v_coupon record;
  v_gender text:=lower(trim(coalesce(p_gender,''))); v_base numeric; v_discount numeric:=0; v_final numeric;
  v_confirmed integer:=0; v_eligible_categories integer:=0; v_remaining integer;
begin
  if v_event_id is null then
    select e.id into v_event_id from public.events e where e.is_active order by e.created_at desc limit 1;
  end if;
  if v_event_id is null then raise exception 'Nenhum evento ativo encontrado.'; end if;

  if p_ticket_category_id is not null then
    return query select * from public.get_registration_pricing_preview_categorized_legacy(
      p_gender,p_coupon_code,v_event_id,p_ticket_category_id);
    return;
  end if;

  select count(*) into v_eligible_categories from public.get_event_ticket_categories(v_event_id) tc
  where tc.is_active and (tc.available_slots is null or tc.available_slots>0) and tc.current_batch_id is not null;
  if v_eligible_categories>0 then
    raise exception using errcode='P0001',message='TICKET_CATEGORY_REQUIRED',
      detail=jsonb_build_object('code','TICKET_CATEGORY_REQUIRED','message','Selecione uma categoria de ingresso.')::text;
  end if;

  select * into v_batch from public.registration_batches rb where rb.event_id=v_event_id and rb.is_active
    and (rb.ends_at is null or now()<=rb.ends_at) order by rb.sequence_number limit 1;
  if not found then raise exception 'Nenhum lote ativo configurado para o evento.'; end if;

  select count(*)::integer into v_confirmed from public.order_items oi
  join public.orders o on o.id=oi.order_id
  where oi.event_id=v_event_id and oi.batch_id=v_batch.id and oi.ticket_category_id is null
    and oi.status='confirmed' and o.status='confirmed';
  if v_confirmed>=v_batch.max_confirmed_registrations then
    raise exception 'Lote esgotado para o ingresso unico.';
  end if;
  v_remaining:=greatest(v_batch.max_confirmed_registrations-v_confirmed,0);

  if v_gender in('feminino','female','f') then v_base:=round(v_batch.female_price,2);
  elsif v_gender in('masculino','male','m') then v_base:=round(v_batch.male_price,2);
  else raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;
  v_final:=v_base;

  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    select * into v_coupon from public.validate_coupon(trim(p_coupon_code),v_event_id,v_base) limit 1;
    v_discount:=round(coalesce(v_coupon.discount_amount,0),2);
    v_final:=round(coalesce(v_coupon.final_amount,v_base),2);
    return query select v_batch.id,v_batch.name,v_batch.sequence_number,v_base,v_discount,v_final,v_remaining,
      coalesce(v_coupon.message,'Cupom aplicado.'),coalesce(v_coupon.coupon_type,''),coalesce(v_coupon.discount_percent,0);
    return;
  end if;
  return query select v_batch.id,v_batch.name,v_batch.sequence_number,v_base,0::numeric,v_final,v_remaining,
    null::text,null::text,0::numeric;
end; $$;

revoke all on function public.get_registration_pricing_preview(text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_registration_pricing_preview(text,text,uuid,uuid) to anon,authenticated;

commit;
