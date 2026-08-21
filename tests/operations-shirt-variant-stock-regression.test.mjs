import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration52 = await readFile(new URL("../supabase/migrations/20260852000000_shirt_size_config_fixed_stock_and_lock_rules.sql", import.meta.url), "utf8");
const migration57 = await readFile(new URL("../supabase/migrations/20260857000000_backfill_canonical_shirt_variant_inventory.sql", import.meta.url), "utf8");
const details = await readFile(new URL("../src/app/operacoes/components/ExpandedTicketDetails.tsx", import.meta.url), "utf8");
const dialog = await readFile(new URL("../src/app/operacoes/components/ConfirmDeliverAndCheckinDialog.tsx", import.meta.url), "utf8");

test("Babylook M e Camiseta M sao identificadas pelo variant_id, nunca apenas pelo tamanho", () => {
  assert.match(migration52, /v_variant_id:=nullif\(v_link\.variant_data->>'variant_id',''\)::uuid/);
  assert.match(migration52, /variant_id=v_variant_id for update/);
  assert.doesNotMatch(migration52, /where\s+shirt_size\s*=\s*v_variant\.value/);
});

test("entrega usa estoque fisico canonico, ignora reservas e bloqueia somente saldo fisico insuficiente", () => {
  const delivery = migration52.slice(
    migration52.indexOf("create or replace function public.deliver_ticket_kit_item"),
    migration52.indexOf("create or replace function public.deliver_ticket_full_kit"),
  );
  assert.match(delivery, /event_kit_item_variant_inventory/);
  assert.match(delivery, /greatest\(v_inv\.total_quantity-v_inv\.delivered_quantity,0\)/);
  assert.match(delivery, /total_quantity-delivered_quantity>=v_link\.quantity/);
  assert.doesNotMatch(delivery, /v_inv\.total_quantity-v_inv\.reserved_quantity-v_inv\.delivered_quantity/);
  assert.doesNotMatch(delivery, /store_item_inventory/);
});

test("undo devolve exatamente na mesma variante canonica", () => {
  const undo = migration52.slice(
    migration52.indexOf("create or replace function public.undo_ticket_kit_item"),
    migration52.indexOf("-- ============================================================\n-- 4)"),
  );
  assert.match(undo, /v_variant_id:=nullif\(v_link\.variant_data->>'variant_id',''\)::uuid/);
  assert.match(undo, /kit_item_id=p_kit_item_id and variant_id=v_variant_id for update/);
  assert.match(undo, /delivered_quantity=delivered_quantity-v_link\.quantity/);
});

test("backfill cria somente correspondencias modelo+tamanho inequivocas e nunca sobrescreve estoque canonico", () => {
  assert.match(migration57, /lower\(trim\(variant\.name\)\) = lower\(trim\(legacy\.shirt_type\)\)/);
  assert.match(migration57, /upper\(trim\(variant\.value\)\) = upper\(trim\(legacy\.shirt_size\)\)/);
  assert.match(migration57, /count\(\*\) over \(partition by legacy\.id\) as match_count/);
  assert.match(migration57, /where match_count = 1/);
  assert.match(migration57, /on conflict \(kit_item_id, variant_id\) do nothing/);
});

test("ficha e confirmacao destacam modelo e tamanho e preservam itens individuais", () => {
  assert.match(details, /`\$\{item\.shirt_type\} — \$\{item\.shirt_size\}`/);
  assert.match(details, /detail\.shirt_stock\.shirt_type\} — \{detail\.shirt_stock\.shirt_size/);
  assert.doesNotMatch(details, /detail\.shirt_stock && detail\.shirt_stock\.status !== "not_applicable"/);
  assert.match(details, /kitItemOperationalLabel\(kitItem\)/);
  assert.match(details, /\.map\(kitItemOperationalLabel\)/);
  assert.match(dialog, /Itens a entregar/);
  assert.match(dialog, /kitItemLabels\.map/);
});
