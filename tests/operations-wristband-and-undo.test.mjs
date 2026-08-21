import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const migrationUrl = new URL('../supabase/migrations/20260848000000_wristband_requirement_and_reason_coded_undo.sql', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const expandedDetailsUrl = new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada na migration`);
  return match[0];
}

test('toda funcao com assinatura alterada tem DROP explicito antes do CREATE (Postgres nao substitui overload por CREATE OR REPLACE)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const [name, oldSignature] of [
    ['checkin_ticket_entry', 'checkin_ticket_entry(uuid)'],
    ['deliver_ticket_kit_item', 'deliver_ticket_kit_item(uuid, uuid)'],
    ['deliver_ticket_full_kit', 'deliver_ticket_full_kit(uuid)'],
    ['deliver_items_and_checkin', 'deliver_items_and_checkin(uuid)'],
    ['undo_ticket_checkin', 'undo_ticket_checkin(uuid)'],
    ['undo_ticket_kit_item', 'undo_ticket_kit_item(uuid, uuid)'],
    ['undo_ticket_full_kit', 'undo_ticket_full_kit(uuid)'],
  ]) {
    assert.match(sql, new RegExp(`drop function if exists public\\.${oldSignature.replace(/[()]/g, '\\$&')};`), `esperado DROP da assinatura antiga de ${name}`);
  }
  // link_wristband_to_ticket mantem a MESMA assinatura (uuid,text) -- so o
  // corpo muda -- por isso nunca deveria ter um DROP (create or replace
  // basta quando a assinatura nao muda).
  assert.doesNotMatch(sql, /drop function if exists public\.link_wristband_to_ticket/);
});

test('link_wristband_to_ticket nao exige mais tickets.participant_id -- so ticket_id e organizacao', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'link_wristband_to_ticket');
  assert.doesNotMatch(fn, /participante vinculado/);
  assert.match(fn, /select e\.\* into v_event from public\.events e where e\.id = v_ticket\.event_id/);
  // participant_id continua sendo gravado quando existir, mas so como
  // referencia opcional (nunca bloqueia o vinculo).
  assert.match(fn, /if v_ticket\.participant_id is not null then/);
});

test('checkin_ticket_entry/deliver_ticket_kit_item/deliver_ticket_full_kit levantam WRISTBAND_REQUIRED (nunca concluem sem pulseira quando exigida)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const [name, flagColumn] of [
    ['checkin_ticket_entry', 'wristband_required_for_checkin'],
    ['deliver_ticket_kit_item', 'wristband_required_for_kit'],
    ['deliver_ticket_full_kit', 'wristband_required_for_kit'],
  ]) {
    const fn = extractFunction(sql, name);
    assert.match(fn, new RegExp(`coalesce\\(v_event\\.${flagColumn}, false\\)`), `${name} precisa checar ${flagColumn}`);
    assert.match(fn, /message = 'WRISTBAND_REQUIRED'/, `${name} precisa levantar WRISTBAND_REQUIRED`);
    assert.match(fn, /perform public\.link_wristband_to_ticket\(v_ticket\.id, p_wristband_code\);/, `${name} precisa vincular a pulseira quando o codigo e fornecido`);
  }
});

test('deliver_ticket_full_kit valida estoque ANTES do gate de pulseira (ingresso -> estoque -> pulseira -> baixa)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_ticket_full_kit');
  const stockLoopIndex = fn.indexOf('for update of pki');
  const wristbandGateIndex = fn.indexOf("message = 'WRISTBAND_REQUIRED'");
  const deliveryLoopIndex = fn.indexOf('perform public.deliver_ticket_kit_item(p_ticket_id,v_row.kit_item_id,p_wristband_code);');
  assert.ok(stockLoopIndex > -1 && wristbandGateIndex > -1 && deliveryLoopIndex > -1, 'blocos esperados nao encontrados');
  assert.ok(stockLoopIndex < wristbandGateIndex, 'estoque precisa ser validado antes do gate de pulseira');
  assert.ok(wristbandGateIndex < deliveryLoopIndex, 'pulseira precisa ser exigida antes de baixar o estoque');
});

test('deliver_items_and_checkin continua uma unica transacao (sem bloco de excecao que engula erro do check-in) e repassa o codigo da pulseira pras duas etapas', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_items_and_checkin');
  assert.doesNotMatch(fn, /exception\s+when/i);
  assert.match(fn, /perform public\.deliver_ticket_full_kit\(p_ticket_id, p_wristband_code\);/);
  assert.match(fn, /select public\.checkin_ticket_entry\(p_ticket_id, p_wristband_code\) into v_ok;/);
  assert.match(fn, /if v_ok is distinct from true then raise exception/);
});

test('undo_ticket_checkin exige motivo valido, nunca desvincula pulseira sem a flag explicita, e registra estado anterior/novo no historico', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'undo_ticket_checkin');
  assert.match(fn, /perform public\.validate_operation_reason_code\(p_reason_code, p_reason_text\);/);
  assert.match(fn, /p_also_unlink_wristband boolean default false/);
  assert.match(fn, /if p_also_unlink_wristband and exists \(/);
  assert.match(fn, /'previous_status', v_previous_status/);
  assert.match(fn, /'new_status', 'active'/);
  assert.match(fn, /'reason_code', p_reason_code/);
});

test('undo_ticket_kit_item/undo_ticket_full_kit exigem motivo e devolvem ao estoque exatamente a quantidade baixada naquela entrega', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const item = extractFunction(sql, 'undo_ticket_kit_item');
  assert.match(item, /perform public\.validate_operation_reason_code\(p_reason_code, p_reason_text\);/);
  assert.match(item, /delivered_quantity=delivered_quantity-v_link\.quantity,reserved_quantity=reserved_quantity\+v_link\.quantity/);
  // Nunca a tabela legada -- mesmo fix ja aplicado em 20260821000000, nao
  // reintroduzido aqui.
  assert.doesNotMatch(item, /public\.shirt_inventory/);

  const full = extractFunction(sql, 'undo_ticket_full_kit');
  assert.match(full, /perform public\.validate_operation_reason_code\(p_reason_code, p_reason_text\);/);
  assert.match(full, /perform public\.undo_ticket_kit_item\(p_ticket_id,v_row\.kit_item_id,p_reason_code,p_reason_text\);/);
});

test('validate_operation_reason_code aceita exatamente os 6 codigos pedidos e exige texto quando "other"', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'validate_operation_reason_code');
  for (const code of ['operational_error', 'wrong_person', 'accidental_scan', 'administrative_correction', 'system_test', 'other']) {
    assert.match(fn, new RegExp(`'${code}'`));
  }
  assert.match(fn, /v_code = 'other' and nullif\(trim\(coalesce\(p_reason_text, ''\)\), ''\) is null/);
});

test('todas as RPCs alteradas tem grant/revoke proprios apos o drop (nunca ficam sem permissao de authenticated)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const signature of [
    'checkin_ticket_entry(uuid, text)',
    'deliver_ticket_kit_item(uuid, uuid, text)',
    'deliver_ticket_full_kit(uuid, text)',
    'deliver_items_and_checkin(uuid, text)',
    'undo_ticket_checkin(uuid, text, text, boolean)',
    'undo_ticket_kit_item(uuid, uuid, text, text)',
    'undo_ticket_full_kit(uuid, text, text)',
    'link_wristband_to_ticket(uuid, text)',
  ]) {
    const escaped = signature.replace(/[()]/g, '\\$&');
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped} to authenticated`), `esperado grant pra ${signature}`);
  }
});

test('actions.ts: undo de check-in/kit exige reason_code no payload (nao ha caminho pra chamar a RPC sem motivo)', async () => {
  const source = await readFile(actionsUrl, 'utf8');
  assert.match(source, /export async function undoCheckinEntryAction\(payload: \{\s*\n\s*ticket_id: string;\s*\n\s*reason_code: string;/);
  assert.match(source, /export async function undoFullKitDeliveryAction\(payload: \{ ticket_id: string; reason_code: string;/);
  assert.match(source, /function validateReasonPayload/);
});

test('actions.ts: acoes de check-in/entrega repassam wristband_code opcional pra RPC (nunca inventam um codigo)', async () => {
  const source = await readFile(actionsUrl, 'utf8');
  assert.match(source, /p_wristband_code: payload\.wristband_code\?\.trim\(\) \|\| null,/);
});

test('actions.ts: pulseira vincula/troca/desvincula reusam as RPCs existentes (nenhuma tabela nova, nenhuma RPC de escrita nova alem do que ja existia)', async () => {
  const source = await readFile(actionsUrl, 'utf8');
  assert.match(source, /supabase\.rpc\("link_wristband_to_ticket"/);
  assert.match(source, /supabase\.rpc\("unlink_wristband_from_ticket"/);
  assert.match(source, /supabase\.rpc\("replace_wristband_for_ticket"/);
});

test('ExpandedTicketDetails: "Também desvincular a pulseira" so aparece no modal de desfazer check-in e comeca desmarcada', async () => {
  const source = await readFile(expandedDetailsUrl, 'utf8');
  const undoCheckinBlock = source.match(/showUndoCheckin \? \(([\s\S]*?)\) : null/);
  assert.ok(undoCheckinBlock, 'bloco do modal de desfazer check-in nao encontrado');
  assert.match(undoCheckinBlock[1], /extraOptionLabel=\{hasActiveWristband \? "Também desvincular a pulseira" : undefined\}/);

  const undoKitBlock = source.match(/showUndoKit \? \(([\s\S]*?)\) : null/);
  assert.ok(undoKitBlock, 'bloco do modal de desfazer entrega nao encontrado');
  assert.doesNotMatch(undoKitBlock[1], /extraOptionLabel/, 'desfazer entrega de kit nao deve ter opcao de pulseira');
});
