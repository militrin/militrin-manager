-- validate_coupon ainda e chamada pelo preview de precificacao legado
-- (get_registration_pricing_preview* -> usado na etapa de selecao de
-- ingresso ANTES do carrinho, e pela pre-visualizacao de cupom em
-- /inscricoes/nova) e por isso precisa continuar funcionando -- mas ela
-- buscava cupons por (event_id, code), que deixou de ser a fonte de escopo
-- apos a migration anterior (coupons.event_id agora e so um resquicio
-- legado, nunca atualizado para cupons novos). Sem este ajuste, todo cupom
-- criado pela nova tela administrativa ficaria invisivel para esse preview
-- antigo (nunca encontrado).
--
-- Ajustada para resolver por (organization_id do evento, code) e usar
-- discount_type/discount_value (novo schema) preservando EXATAMENTE a
-- mesma assinatura e o mesmo formato de retorno (coupon_type continua
-- devolvendo 'courtesy' quando o desconto e 100% percentual, para nao
-- quebrar nenhum consumidor que ja lia esse campo). Limitacao aceita e
-- documentada: este caminho legado so enxerga elegibilidade em nivel de
-- EVENTO (aplica_a_ingressos + escopo de evento), nao de categoria -- a
-- fonte de verdade real e completa (incluindo categoria e produtos) e
-- apply_cart_coupon, usada na etapa Carrinho.
begin;

create or replace function public.validate_coupon(p_code text, p_event_id uuid, p_original_amount numeric)
 RETURNS TABLE(coupon_id uuid, coupon_type text, discount_percent numeric, discount_amount numeric, final_amount numeric, message text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_code text;
  v_org uuid;
  v_coupon public.coupons%rowtype;
  v_now timestamptz := now();
  v_discount numeric;
  v_final numeric;
  v_event_eligible boolean;
begin
  v_code := upper(trim(coalesce(p_code, '')));

  if v_code = '' then
    raise exception 'Informe um codigo de cupom.';
  end if;

  if p_event_id is null then
    raise exception 'Evento invalido para validacao de cupom.';
  end if;

  if p_original_amount is null or p_original_amount < 0 then
    raise exception 'Valor original invalido.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null then raise exception 'Evento invalido para validacao de cupom.'; end if;

  select * into v_coupon
  from public.coupons
  where organization_id = v_org
    and code = v_code
  for update;

  if not found then
    raise exception 'Codigo invalido para este evento.';
  end if;

  if not v_coupon.applies_to_tickets then
    raise exception 'Este cupom nao se aplica a ingressos.';
  end if;

  select (
    not exists(select 1 from public.coupon_event_scopes s where s.coupon_id = v_coupon.id)
    or exists(select 1 from public.coupon_event_scopes s where s.coupon_id = v_coupon.id and s.event_id = p_event_id)
  ) into v_event_eligible;
  if not v_event_eligible then
    raise exception 'Cupom nao e valido para este evento.';
  end if;

  if not v_coupon.is_active then raise exception 'Cupom inativo.'; end if;
  if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then raise exception 'Cupom ainda nao esta vigente.'; end if;
  if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then raise exception 'Cupom expirado.'; end if;
  if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then raise exception 'Limite de usos do cupom atingido.'; end if;

  if v_coupon.discount_type = 'percentage' then
    v_discount := round((p_original_amount * v_coupon.discount_value) / 100.0, 2);
    v_final := round(greatest(0, p_original_amount - v_discount), 2);
  else
    v_discount := round(least(v_coupon.discount_value, p_original_amount), 2);
    v_final := round(greatest(0, p_original_amount - v_discount), 2);
  end if;

  return query
  select
    v_coupon.id,
    case when v_coupon.discount_type = 'percentage' and v_coupon.discount_value = 100 then 'courtesy' else 'percentage' end,
    case when v_coupon.discount_type = 'percentage' then v_coupon.discount_value else 0 end,
    v_discount,
    v_final,
    case
      when v_coupon.discount_type = 'percentage' and v_coupon.discount_value = 100 then 'Cortesia aplicada com sucesso.'
      else 'Cupom valido e pronto para aplicacao.'
    end;
end;
$function$;

commit;
