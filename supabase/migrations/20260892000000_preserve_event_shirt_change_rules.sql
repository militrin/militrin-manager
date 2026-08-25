begin;

-- O trigger historico tinha duas responsabilidades misturadas: exigir modo
-- explicito e, em toda escrita de camiseta, forcar allow_participant_change
-- para false. Isso anulava silenciosamente a RPC de configuracao. Mantemos
-- apenas a validacao do modo, que e a responsabilidade canonica do trigger.
create or replace function public.enforce_explicit_shirt_supply_mode()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.item_type='shirt' and new.is_active and new.shirt_supply_mode is null then
    raise exception 'Camiseta ativa exige modo stock, made_to_order ou disabled.';
  end if;
  return new;
end; $$;

commit;
