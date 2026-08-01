-- 055_fix_participant_kit_items_conflict.sql

-- 1. Remove duplicados, mantendo o registro mais antigo
delete from public.participant_kit_items a
using public.participant_kit_items b
where a.participant_id = b.participant_id
  and a.kit_item_id = b.kit_item_id
  and a.created_at > b.created_at;

-- 2. Cria a restrição única necessária
alter table public.participant_kit_items
add constraint participant_kit_items_participant_kit_unique
unique (participant_id, kit_item_id);