begin;

-- Auditoria da Central de Integridade Operacional: TICKET_MISSING_REQUIRED_SHIRT_VARIANT
-- tratava a AUSENCIA de participant_kit_items.variant_data->>'variant_id' como
-- "camiseta nao definida". Investigacao mais precisa (revisao pre-push, sem
-- confiar so em grep): a trigger trg_attach_unresolved_kit_items_to_ticket
-- (AFTER INSERT em tickets -> attach_order_item_kit_items_to_new_ticket())
-- JA cria participant_kit_items automaticamente pra todo ingresso emitido
-- com kit ativo -- mas em formato "nao resolvido": so copia
-- order_items.shirt_type/shirt_size cru pro variant_data, sem NUNCA procurar
-- o variant_id correspondente em event_kit_item_variants. variant_id so e'
-- preenchido depois, por acoes operacionais pontuais (entrega de kit, troca
-- administrativa de camiseta, emissao manual -- ver ensure_ticket_kit_items
-- e seus chamadores). Ou seja: um ingresso recem-pago, com tamanho de
-- camiseta ja escolhido no checkout, mas ainda nao entregue nem corrigido
-- manualmente, tem participant_kit_items com variant_data={shirt_type,shirt_size}
-- e NUNCA tera variant_id ate uma dessas acoes rodar -- e era considerado
-- "sem camiseta" por um detector que nunca olhou pra fonte onde o tamanho
-- realmente mora nesse meio-tempo.
--
-- Confirmado com os 3 ingressos reais que a Central apontava (todos Open Bar,
-- ticket_status=active, pki existente com variant_data={shirt_type,shirt_size}
-- sem variant_id, exatamente o formato "nao resolvido" da trigger acima):
-- em todos os 3, order_items.shirt_type/shirt_size bate com exatamente 1
-- variante ativa de event_kit_item_variants -- ou seja, o tamanho existe e
-- e' valido em uma fonte canonica (o checkout), a Integridade so consultava
-- a coluna errada (o vinculo operacional, que ainda nao foi materializado).
--
-- Fonte canonica corrigida: um ingresso so e' "sem camiseta" quando NENHUMA
-- das duas fontes resolve um tamanho valido:
--   1) participant_kit_items.variant_data->>'variant_id' (vinculo operacional
--      ja materializado, ex.: apos entrega/troca), OU
--   2) order_items.shirt_type/shirt_size batendo com exatamente 1 variante
--      ativa do kit do evento (selecao feita no checkout, ainda nao
--      materializada operacionalmente -- nao e' um problema, e' o estado
--      normal antes da entrega).
-- Isso NAO copia dado nenhum entre tabelas; so amplia a regra pra reconhecer
-- a segunda fonte, hoje ja canonica no restante do sistema (ensure_ticket_kit_items
-- usa a MESMA junta por nome/valor pra decidir a variante).
create or replace function public.detect_integrity_missing_shirt_variant(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_MISSING_REQUIRED_SHIRT_VARIANT'::text, 'attention'::text, 'camisetas_kits'::text,
    'Camiseta não definida'::text,
    'Este ingresso tem direito a camiseta, mas ainda não possui tamanho/variante definido.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id || '/editar',
    jsonb_build_object(
      'kit_item_id', eki.id, 'kit_item_name', eki.name,
      'holder_name', coalesce(rc.full_name, oi.holder_full_name), 'event_name', ev.name,
      'category_name', tc.name, 'ticket_code', '#' || upper(left(t.token::text, 8))
    )
  from public.tickets t
  join public.event_kit_items eki on eki.event_id = t.event_id and eki.item_type = 'shirt' and eki.is_active = true and eki.requires_variant = true
  join public.events ev on ev.id = t.event_id
  left join public.order_items oi on oi.id = t.order_item_id
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.participant_kit_items pki on pki.kit_item_id = eki.id
    and pki.status <> 'cancelled'
    and (pki.ticket_id = t.id or (pki.ticket_id is null and pki.order_item_id = t.order_item_id))
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and t.status <> 'cancelled'
    and coalesce(pki.variant_data->>'variant_id', '') = ''
    and not exists (
      select 1 from public.event_kit_item_variants v
      where v.kit_item_id = eki.id and v.is_active
        and lower(trim(v.name)) = lower(trim(oi.shirt_type))
        and upper(trim(v.value)) = upper(trim(oi.shirt_size))
    );
$$;
revoke all on function public.detect_integrity_missing_shirt_variant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_missing_shirt_variant(uuid, uuid) to service_role;

commit;
