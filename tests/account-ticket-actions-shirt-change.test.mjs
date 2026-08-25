import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
const actionsUi = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/ticket-context-actions.tsx', import.meta.url), 'utf8');
const holderUi = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/ticket-holder-actions.tsx', import.meta.url), 'utf8');
const serverActions = await readFile(new URL('../src/app/minha-conta/actions.ts', import.meta.url), 'utf8');
const schema = await readFile(new URL('../supabase/migrations/20260815001914_remote_schema.sql', import.meta.url), 'utf8');
const shirtRules = await readFile(new URL('../supabase/migrations/20260852000000_shirt_size_config_fixed_stock_and_lock_rules.sql', import.meta.url), 'utf8');

test('titularidade e propriedade ficam semanticamente separadas', () => {
  assert.match(holderUi, /Transferir titularidade do ingresso/);
  assert.match(holderUi, /Para transferir a propriedade do ingresso, contate um administrador\./);
  assert.match(holderUi, /transferTicketByPinAction/);
  assert.doesNotMatch(holderUi, /tickets\.transfer_ownership|owner_user_id/);
});

test('ação aparece somente com as flags canônicas do evento e do item', () => {
  assert.match(page, /eventObj\?\.allow_participant_item_changes/);
  assert.match(page, /participantShirtRule\?\.allow_participant_change/);
  assert.match(page, /participantShirtRule\?\.requires_variant/);
  assert.match(page, /participantShirtChangeEnabled \? <ParticipantShirtChangeAction/);
  assert.doesNotMatch(actionsUi, /inventory\.change_participant_shirt/);
});

test('tipo e tamanho reais aparecem juntos na ficha e no modal', () => {
  assert.match(page, /currentLabel={`\$\{shirtType\} — \$\{shirtSize\}`}/);
  assert.match(actionsUi, /Tamanho atual:/);
  assert.match(actionsUi, /Alterar tamanho da camiseta/);
  assert.match(actionsUi, /Novo tamanho/);
  assert.match(actionsUi, /Cancelar/);
  assert.match(actionsUi, /Confirmar alteração/);
});

test('kit entregue, check-in e solicitação pendente bloqueiam nova alteração', () => {
  assert.match(page, /shirtDelivered[\s\S]*camiseta já foi entregue/);
  assert.match(page, /checkinDone[\s\S]*não está disponível após o check-in/);
  assert.match(page, /pendingShirtRequest[\s\S]*aguardando confirmação do organizador/);
  assert.match(actionsUi, /disabledReason \? [\s\S]*: <button/);
});

test('estoque obrigatório desabilita zero físico e sob encomenda não filtra', () => {
  assert.match(page, /requireStockForChoice = String\(participantShirtRule\?\.shirt_supply_mode \?\? ''\) === 'stock'/);
  assert.match(page, /physicallyAvailable = Number\(inventory\?\.total_quantity \?\? 0\) - Number\(inventory\?\.delivered_quantity \?\? 0\)/);
  assert.match(page, /disabled: requireStockForChoice && physicallyAvailable <= 0/);
  assert.doesNotMatch(page, /physicallyAvailable[^\n]*reserved_quantity/);
});

test('confirmação reutiliza action/RPC existente e atualiza a ficha', () => {
  assert.match(actionsUi, /requestTicketItemChangeAction\(form\)/);
  assert.match(actionsUi, /router\.refresh\(\)/);
  assert.match(serverActions, /supabase\.rpc\('request_ticket_item_change'/);
  assert.match(serverActions, /revalidatePath\(`\/minha-conta\/ingressos\/\$\{ticketId\}`\)/);
  assert.match(schema, /if not v_event\.allow_participant_item_changes or not v_item\.allow_participant_change/);
  assert.match(schema, /perform public\.change_ticket_shirt\(v_req\.ticket_id/);
});

test('backend efetivo preserva bloqueios operacionais existentes', () => {
  assert.match(shirtRules, /SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION/);
  assert.match(shirtRules, /v_ticket\.status='used' or v_ticket\.used_at is not null/);
  assert.match(shirtRules, /v_link\.status='delivered'/);
  assert.match(shirtRules, /v_item\.shirt_supply_mode='stock'/);
  assert.match(shirtRules, /v_available<v_qty/);
});
