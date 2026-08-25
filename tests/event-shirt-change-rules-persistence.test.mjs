import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20260892000000_preserve_event_shirt_change_rules.sql', import.meta.url), 'utf8');
const rpcMigration = await readFile(new URL('../supabase/migrations/20260852000000_shirt_size_config_fixed_stock_and_lock_rules.sql', import.meta.url), 'utf8');
const action = await readFile(new URL('../src/app/eventos/actions.ts', import.meta.url), 'utf8');
const component = await readFile(new URL('../src/app/painel/eventos/[id]/item-change-rules.tsx', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url), 'utf8');

test('trigger preserva allow_participant_change marcado e desmarcado', () => {
  assert.match(migration, /create or replace function public\.enforce_explicit_shirt_supply_mode/);
  assert.doesNotMatch(migration, /allow_participant_change\s*:?=/);
  assert.match(migration, /return new/);
});

test('RPC atual persiste ambos os valores booleanos sem assinatura antiga', () => {
  assert.match(action, /p_allow_change: allowChange/);
  assert.match(action, /p_require_stock_for_choice: requireStockForChoice \?\? null/);
  assert.match(rpcMigration, /p_require_stock_for_choice boolean default null/);
  assert.match(rpcMigration, /shirt_supply_mode=case when coalesce\(p_require_stock_for_choice,true\) then 'stock' else 'made_to_order' end/);
});

test('action rele a mesma linha e devolve estado canonico apos salvar', () => {
  assert.match(action, /from\("event_kit_items"\)[\s\S]*\.eq\("id", itemId\)\.maybeSingle\(\)/);
  assert.match(action, /revalidatePath\(`\/painel\/eventos\/\$\{saved\.event_id\}`\)/);
  assert.match(action, /requireStockForChoice: saved\.shirt_supply_mode === "stock"/);
});

test('componente controlado aplica o valor relido e nao props antigas', () => {
  assert.match(component, /checked={item\.allow_participant_change}/);
  assert.match(component, /checked={item\.require_stock_for_choice}/);
  assert.match(component, /result\.success && result\.saved/);
  assert.match(component, /allow_participant_change: result\.saved\.allowParticipantChange/);
  assert.match(component, /require_stock_for_choice: result\.saved\.requireStockForChoice/);
});

test('reload consulta todos os itens do evento e deriva stock da coluna canonica', () => {
  assert.match(page, /from\("event_kit_items"\)\.select\("id,name,item_type,requires_variant,allow_participant_change,track_variant_inventory,shirt_supply_mode"\)\.eq\("event_id", id\)/);
  assert.match(page, /require_stock_for_choice: item\.shirt_supply_mode === "stock"/);
});

test('consumidor da Minha Conta usa allow e bloqueia estoque zero apenas em stock', async () => {
  const account = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
  assert.match(account, /participantShirtRule\?\.allow_participant_change/);
  assert.match(account, /requireStockForChoice = String\(participantShirtRule\?\.shirt_supply_mode \?\? ''\) === 'stock'/);
  assert.match(account, /disabled: requireStockForChoice && physicallyAvailable <= 0/);
});
