import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("emissao materializa demanda de camiseta uma unica vez", async () => {
  const sql = await read("../supabase/migrations/20260880000000_canonical_manual_shirt_demand_and_stock.sql");
  assert.match(sql, /inventory_reservation_accounted boolean not null default false/);
  assert.match(sql, /create or replace function public\.account_ticket_shirt_demand/);
  assert.match(sql, /if not found or v_link\.inventory_reservation_accounted/);
  assert.match(sql, /perform public\.account_ticket_shirt_demand\(v_link\)/);
  assert.match(sql, /pki\.status not in\('delivered','cancelled'\)/);
  assert.match(sql, /create or replace function public\.issue_manual_ticket_batch/);
  assert.match(sql, /perform public\.ensure_ticket_kit_items\(v_extra\.ticket_id\)/);
});

test("estoque fisico legado e espelhado no saldo ticket-first", async () => {
  const sql = await read("../supabase/migrations/20260880000000_canonical_manual_shirt_demand_and_stock.sql");
  assert.match(sql, /sync_shirt_physical_total_to_kit_inventory/);
  assert.match(sql, /after insert or update of total_quantity,shirt_type,shirt_size on public\.shirt_inventory/);
  assert.match(sql, /total_quantity=greatest\(excluded\.total_quantity,event_kit_item_variant_inventory\.delivered_quantity\)/);
  assert.doesNotMatch(sql, /total_quantity\s*-\s*reserved_quantity\s*-\s*delivered_quantity/);
});

test("tela de camisetas separa demanda reservada de disponibilidade fisica", async () => {
  const page = await read("../src/app/camisetas/page.tsx");
  assert.match(page, /event_kit_item_variant_inventory/);
  assert.match(page, /reserved_quantity: reserved/);
  assert.match(page, /available: Math\.max\(row\.total_quantity - delivered, 0\)/);
});

test("ficha usa a camiseta ticket-first e nunca deixa o navegador escolher outra variante", async () => {
  const page = await read("../src/app/inscricoes/[id]/page.tsx");
  assert.match(page, /shirtVariant\?\.shirt_type \?\? ticketItem\?\.shirt_type/);
  assert.match(page, /shirtVariant\?\.shirt_size \?\? ticketItem\?\.shirt_size/);
  assert.match(page, /<select disabled value=\{currentShirtKey\}/);
  assert.match(page, /label: `\$\{currentShirtType\} \$\{currentShirtSize\} \(sem estoque\)`/);
  assert.doesNotMatch(page, /defaultValue=\{`\$\{participant\.shirt_type\}/);
});

test("entrega usa estoque fisico, trava a linha e protege a ultima unidade", async () => {
  const sql = await read("../supabase/migrations/20260852000000_shirt_size_config_fixed_stock_and_lock_rules.sql");
  assert.match(sql, /greatest\(v_inv\.total_quantity-v_inv\.delivered_quantity,0\)/);
  assert.match(sql, /where kit_item_id=v_item\.id and variant_id=v_variant_id for update/);
  assert.match(sql, /and total_quantity-delivered_quantity>=v_link\.quantity/);
  assert.match(sql, /delivered_quantity=delivered_quantity\+v_link\.quantity/);
  assert.match(sql, /reserved_quantity=greatest\(reserved_quantity-v_link\.quantity,0\)/);
});

test("Central lista tickets do evento sem excluir cortesia ou emissao administrativa", async () => {
  const actions = await read("../src/app/operacoes/actions.ts");
  const start = actions.indexOf('export async function listOperationTicketsAction');
  const end = actions.indexOf('export async function listPickupParticipantsAction');
  const list = actions.slice(start, end);
  const ticketQuery = list.slice(list.indexOf('const { data: ticketRows'), list.indexOf('if (ticketError)'));
  assert.match(ticketQuery, /\.from\("tickets"\)/);
  assert.match(ticketQuery, /\.eq\("event_id", eventId\)/);
  assert.doesNotMatch(ticketQuery, /\.eq\("payment_method"/);
  assert.doesNotMatch(ticketQuery, /\.eq\("buyer_type"/);
  assert.doesNotMatch(ticketQuery, /\.not\("participant_id"/);
});
