import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20261113000000_wristband_replace_atomic_and_checkin_audit.sql', import.meta.url);
const previousCheckinUrl = new URL('../supabase/migrations/20261017000000_legacy_paid_operational_payment.sql', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const expandedUrl = new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url);
const rowUrl = new URL('../src/app/operacoes/components/OperationRow.tsx', import.meta.url);
const turboUrl = new URL('../src/app/operacoes/components/TurboMode.tsx', import.meta.url);
const reasonUrl = new URL('../src/app/operacoes/components/ReasonDialog.tsx', import.meta.url);
const replaceDialogUrl = new URL('../src/app/operacoes/components/ReplaceWristbandDialog.tsx', import.meta.url);
const confirmCheckinUrl = new URL('../src/app/operacoes/components/ConfirmCheckinDialog.tsx', import.meta.url);
const fichaUrl = new URL('../src/app/minha-conta/ingressos/[ticketId]/ticket-operational-controls.tsx', import.meta.url);
const fichaPageUrl = new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url);
const typesUrl = new URL('../src/app/operacoes/types.ts', import.meta.url);
const taxonomyUrl = new URL('../src/lib/admin/ticket-event-taxonomy.ts', import.meta.url);
const reportsUrl = new URL('../src/lib/reports/queries/operacoes.ts', import.meta.url);
const timelineUrl = new URL('../src/lib/account/access-timeline.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend;\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

const sql = await readFile(migrationUrl, 'utf8');
const previousCheckin = await readFile(previousCheckinUrl, 'utf8');
const actions = await readFile(actionsUrl, 'utf8');
const expanded = await readFile(expandedUrl, 'utf8');
const row = await readFile(rowUrl, 'utf8');
const turbo = await readFile(turboUrl, 'utf8');
const reason = await readFile(reasonUrl, 'utf8');
const replaceDialog = await readFile(replaceDialogUrl, 'utf8');
const confirmCheckin = await readFile(confirmCheckinUrl, 'utf8');
const ficha = await readFile(fichaUrl, 'utf8');
const fichaPage = await readFile(fichaPageUrl, 'utf8');
const types = await readFile(typesUrl, 'utf8');
const taxonomy = await readFile(taxonomyUrl, 'utf8');
const reports = await readFile(reportsUrl, 'utf8');
const timeline = await readFile(timelineUrl, 'utf8');

test('1 e 19: evento exige pulseira + sem vinculo => check-in ainda levanta WRISTBAND_REQUIRED (sem bypass)', () => {
  const fn = extractFunction(sql, 'checkin_ticket_entry');
  assert.match(fn, /wristband_required_for_checkin/);
  assert.match(fn, /message = 'WRISTBAND_REQUIRED'/);
  assert.match(fn, /if nullif\(trim\(coalesce\(p_wristband_code, ''\)\), ''\) is null then/);
  assert.match(previousCheckin, /message = 'WRISTBAND_REQUIRED'/);
});

test('2: pulseira ativa => gate de WRISTBAND_REQUIRED nao dispara (exists active)', () => {
  const fn = extractFunction(sql, 'checkin_ticket_entry');
  assert.match(fn, /select exists\(select 1 from public\.participant_wristbands pw where pw\.ticket_id = v_ticket\.id and pw\.status = 'active'\) into v_has_wristband;/);
  assert.match(fn, /if not v_has_wristband then/);
});

test('3: check-in novo registra wristband_code/id/status no audit (sem backfill)', () => {
  const fn = extractFunction(sql, 'checkin_ticket_entry');
  assert.match(fn, /'wristband_code', v_wristband\.code/);
  assert.match(fn, /'wristband_id', v_wristband\.id/);
  assert.match(fn, /'wristband_status', v_wristband\.status/);
  assert.doesNotMatch(sql, /update public\.audit_logs/);
  assert.match(sql, /Sem backfill/);
});

test('regra de obrigatoriedade do check-in nao mudou em relacao a 20261017', () => {
  const current = extractFunction(sql, 'checkin_ticket_entry');
  const previous = extractFunction(previousCheckin, 'checkin_ticket_entry');
  const gate = (fn) => {
    const start = fn.indexOf('wristband_required_for_checkin');
    const end = fn.indexOf('update public.tickets set status');
    return fn.slice(start, end).replace(/\s+/g, ' ');
  };
  assert.equal(gate(current), gate(previous));
});

test('4 e 5 e 20 Magna: undo default keep; refazer check-in usa pulseira existente sem pedir nova', () => {
  assert.match(actions, /p_also_unlink_wristband: Boolean\(payload\.also_unlink_wristband\)/);
  assert.match(actions, /Check-in desfeito\. A pulseira permanece vinculada\./);
  assert.match(reason, /Manter pulseira vinculada/);
  assert.match(reason, /useState\(false\)/);
  assert.match(confirmCheckin, /Este ingresso já possui pulseira vinculada/);
  assert.match(confirmCheckin, /Confirmar check-in/);
  assert.match(expanded, /if \(hasActiveWristband\) \{\s*setShowCheckinConfirm\(true\)/);
  assert.match(row, /if \(hasActiveWristband\) \{\s*setShowCheckinConfirm\(true\)/);
  assert.match(turbo, /needsWristband = event\.wristband_enabled && participant\.wristband\?\.status !== 'active'/);
});

test('6: undo + unlink mapeia extraOption para p_also_unlink_wristband true', () => {
  assert.match(expanded, /alsoUnlinkWristband: extraOption/);
  assert.match(ficha, /also_unlink_wristband: extraOption/);
  assert.match(actions, /Check-in desfeito e pulseira desvinculada\./);
});

test('7: check-in depois do unlink continua WRISTBAND_REQUIRED (backend autoridade)', () => {
  const fn = extractFunction(sql, 'checkin_ticket_entry');
  assert.match(fn, /pw\.status = 'active'/);
  assert.match(fn, /message = 'WRISTBAND_REQUIRED'/);
});

test('8-12: substituicao atomica desativa antiga, vincula nova, rollback em falha, ocupada nao rouba', () => {
  const fn = extractFunction(sql, 'replace_wristband_for_ticket');
  assert.match(fn, /status = 'replaced'/);
  assert.match(fn, /insert into public\.participant_wristbands/);
  const deactivateAt = fn.indexOf("status = 'replaced'");
  const insertAt = fn.indexOf('insert into public.participant_wristbands');
  assert.ok(deactivateAt > -1 && insertAt > deactivateAt, 'desativa antiga antes de inserir a nova, na mesma transacao');
  assert.match(fn, /Este ingresso nao possui pulseira ativa para substituir/);
  assert.match(fn, /Esta pulseira já está vinculada a outro ingresso\./);
  assert.doesNotMatch(fn, /update public\.participant_wristbands[\s\S]*status = 'unlinked'[\s\S]*v_existing/);
  assert.match(fn, /exception\s+when unique_violation then/);
  assert.match(fn, /raise exception using/);
  assert.doesNotMatch(fn, /exception\s+when others/i);
  assert.doesNotMatch(fn, /set status='used'|set status='active'/);
  assert.doesNotMatch(fn, /participant_kit_items/);
});

test('9 e 10: substituicao nao mexe em check-in used nem kit entregue', () => {
  const fn = extractFunction(sql, 'replace_wristband_for_ticket');
  assert.doesNotMatch(fn, /update public\.tickets/);
  assert.doesNotMatch(fn, /deliver_ticket|undo_ticket|checkin_ticket/);
});

test('13: concorrencia — lock FOR UPDATE + unique index + unique_violation', () => {
  const fn = extractFunction(sql, 'replace_wristband_for_ticket');
  assert.match(fn, /from public\.tickets t[\s\S]*for update/);
  assert.match(fn, /status = 'active'[\s\S]*for update/);
  assert.match(sql, /participant_wristbands_event_code_active_uidx/);
  assert.match(fn, /unique_violation/);
});

test('14: historico wristband_replaced com old/new/reason/operator', () => {
  const fn = extractFunction(sql, 'replace_wristband_for_ticket');
  assert.match(fn, /'wristband_replaced'/);
  assert.match(fn, /'old_wristband_code', v_old\.code/);
  assert.match(fn, /'new_wristband_code', v_new\.code/);
  assert.match(fn, /'reason_code', v_reason_code/);
  assert.match(fn, /'reason_text', v_reason_text/);
  assert.match(fn, /'operator_user_id', auth\.uid\(\)/);
  assert.match(taxonomy, /wristband_replaced: \{ label: "Pulseira substituída"/);
  assert.match(reports, /wristband_replaced: \{ label: "Pulseira substituída"/);
  assert.match(timeline, /wristband_replaced: "Pulseira substituída"/);
  assert.match(actions, /wristband_replaced/);
});

test('15 e 16: motivo obrigatorio e Outro exige texto', () => {
  const validator = extractFunction(sql, 'validate_wristband_replace_reason_code');
  for (const code of ['damaged', 'lost', 'incorrectly_linked', 'operational_swap', 'other']) {
    assert.match(validator, new RegExp(`'${code}'`));
  }
  assert.match(validator, /v_code = 'other' and nullif\(trim\(coalesce\(p_reason_text, ''\)\), ''\) is null/);
  assert.match(replaceDialog, /if \(!reasonCode\)/);
  assert.match(replaceDialog, /reasonCode === "other" && !reasonText\.trim\(\)/);
  assert.match(actions, /payload\.reason_code === "other" && !payload\.reason_text\?\.trim\(\)/);
  assert.match(types, /damaged: 'Danificada'/);
  assert.match(types, /lost: 'Perdida'/);
  assert.match(types, /incorrectly_linked: 'Vinculada incorretamente'/);
  assert.match(types, /operational_swap: 'Troca operacional'/);
});

test('17: usuario sem permissao e bloqueado no backend (wristbands.replace)', () => {
  const fn = extractFunction(sql, 'replace_wristband_for_ticket');
  assert.match(fn, /current_user_has_permission\('wristbands\.replace'\)/);
  assert.match(fn, /Sem permissao para substituir pulseira/);
  assert.match(actions, /await assertPermission\("wristbands\.replace"\)/);
  assert.match(expanded, /canReplace=\{capabilities\.canReplaceWristband\}/);
  assert.match(ficha, /canReplace=\{props\.canReplaceWristband\}/);
});

test('18: Turbo/Central/ficha mostram pulseira atual e Substituir pulseira', () => {
  assert.match(expanded, /WristbandLinkedPanel/);
  assert.match(expanded, /Substituir pulseira|onReplace=\{\(\) => setShowReplaceWristband\(true\)\}/);
  assert.match(row, /WristbandLinkedPanel/);
  assert.match(turbo, /label="Pulseira vinculada"/);
  assert.match(turbo, /Substituir pulseira/);
  assert.match(ficha, /WristbandLinkedPanel/);
  assert.match(fichaPage, /hasActiveWristband=\{hasActiveWristband\}/);
  assert.match(fichaPage, /canReplaceWristband=\{canReplaceWristband\}/);
});

test('8 UI: substituir funciona mesmo com kit entregue / check-in usado — botao nao e gated por status', () => {
  assert.doesNotMatch(expanded, /canReplaceWristband && detail\.checkin_status !== "done"/);
  assert.doesNotMatch(expanded, /canReplaceWristband && !detail\.all_kit_delivered/);
  assert.match(expanded, /canReplace=\{capabilities\.canReplaceWristband\}/);
});

test('11 ocupada: mensagem clara na RPC e na action', () => {
  assert.match(sql, /Esta pulseira já está vinculada a outro ingresso\./);
  assert.match(actions, /Esta pulseira já está vinculada a outro ingresso\./);
});

test('undo kit nao pergunta pulseira; nao existe undo combinado inventado', () => {
  assert.doesNotMatch(expanded, /showUndoKit[\s\S]{0,400}wristbandKeepPrompt/);
  assert.doesNotMatch(ficha, /undoPrompt === "kit"[\s\S]{0,500}wristbandKeepPrompt/);
  assert.match(turbo, /wristbandKeepPrompt=\{undoKind === 'checkin' && activeWristbandCode/);
  assert.doesNotMatch(expanded, /Desfazer entrega \+ check-in/);
  assert.doesNotMatch(row, /Desfazer entrega \+ check-in/);
  assert.doesNotMatch(turbo, /Desfazer entrega \+ check-in/);
});

test('check-in sem pulseira obriga Vincular pulseira na UI, backend continua WRISTBAND_REQUIRED', () => {
  assert.match(expanded, /if \(wristbandRequiredForCheckin\) \{\s*setWristbandModal\("mandatory-checkin"\)/);
  assert.match(row, /if \(wristbandRequiredForCheckin\) \{\s*setWristbandModal\("mandatory-checkin"\)/);
  assert.match(ficha, /setWristbandPrompt\("checkin"\)/);
  assert.match(ficha, /title="Vincular pulseira"/);
});

test('feedback operacional de substituicao e undo', () => {
  assert.match(actions, /Pulseira substituída com sucesso\./);
  assert.match(actions, /Check-in desfeito\. A pulseira permanece vinculada\./);
  assert.match(actions, /Check-in desfeito e pulseira desvinculada\./);
});

test('drop da assinatura antiga de replace e grant da nova', () => {
  assert.match(sql, /drop function if exists public\.replace_wristband_for_ticket\(uuid, text, text\);/);
  assert.match(sql, /grant execute on function public\.replace_wristband_for_ticket\(uuid, text, text, text\) to authenticated/);
  assert.match(sql, /grant execute on function public\.checkin_ticket_entry\(uuid, text\) to authenticated/);
});

test('ReasonDialog default manter: extraOption inicia false e radio Manter e o checked quando !extraOption', () => {
  assert.match(reason, /const \[extraOption, setExtraOption\] = useState\(false\);/);
  assert.match(reason, /checked=\{!extraOption\}/);
  assert.match(reason, /onChange=\{\(\) => setExtraOption\(false\)\}/);
  assert.match(reason, /onChange=\{\(\) => setExtraOption\(true\)\}/);
});
