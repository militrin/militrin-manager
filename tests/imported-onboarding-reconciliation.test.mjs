import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260940000000_reconcile_imported_ticket_issuance_after_data_fix.sql', import.meta.url), 'utf8');
const firstAccess = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const cadastrosPage = await readFile(new URL('../src/app/cadastros/page.tsx', import.meta.url), 'utf8');
const ingressosPage = await readFile(new URL('../src/app/ingressos/page.tsx', import.meta.url), 'utf8');

const participantReconciliation = migration.match(/create or replace function public\.reconcile_imported_ticket_issuance_for_participant[\s\S]*?revoke all on function public\.reconcile_imported_ticket_issuance_for_participant/)?.[0] ?? '';
const userReconciliation = migration.match(/create or replace function public\.reconcile_imported_ticket_issuance_for_user[\s\S]*?revoke all on function public\.reconcile_imported_ticket_issuance_for_user/)?.[0] ?? '';
const finalizer = migration.match(/create or replace function public\.finalize_imported_ticket_after_issue_resolution[\s\S]*?end; \$\$;/)?.[0] ?? '';

test('importado sem pendencia passa pela reconciliacao final do primeiro acesso', () => {
  assert.match(firstAccess, /reconcile_imported_ticket_issuance_for_user/);
  assert.ok(firstAccess.indexOf('reconcile_imported_ticket_issuance_for_user') > firstAccess.indexOf('update_registration_contact_from_participant'));
});

for (const field of ['gender', 'cpf', 'birth_date', 'phone', 'city']) {
  test(`${field} corrigido e reconciliado sem acoplamento a uma issue especifica`, () => {
    assert.match(firstAccess, new RegExp(`allowed\\.has\\('${field}'\\)`));
    assert.match(migration, /reconcile_imported_ticket_issuance_for_participant\(v_p\.id\)/);
    assert.match(participantReconciliation, /finalize_imported_ticket_after_issue_resolution/);
  });
}

test('multiplas pendencias so liberam depois da ultima bloqueante', () => {
  assert.match(finalizer, /status='open' and i\.blocks_ticket_issuance/);
  assert.match(finalizer, /if v_blocked then\s+v_finalization:='issues_remaining'/);
});

test('repetir finalizacao nao duplica ticket', () => {
  assert.match(participantReconciliation, /not exists \(select 1 from public\.tickets t where t\.order_item_id = oi\.id\)/);
  assert.match(finalizer, /select id into v_ticket_id from public\.tickets where order_item_id=v_item\.id/);
  assert.match(finalizer, /if v_ticket_id is null then select public\.confirm_order_item_and_issue_ticket/);
});

test('dois ingressos importados validos sao todos percorridos', () => {
  assert.match(participantReconciliation, /for v_row in[\s\S]*order by oi\.created_at/);
  assert.match(participantReconciliation, /v_attempted := v_attempted \+ 1/);
  assert.match(userReconciliation, /for v_participant in/);
  assert.match(userReconciliation, /v_results:=v_results\|\|coalesce\(v_summary->'results'/);
});

test('produto de loja no mesmo pedido nunca entra na emissao', () => {
  assert.match(participantReconciliation, /oi\.item_kind = 'ticket'/);
  assert.doesNotMatch(participantReconciliation, /item_kind\s*(?:<>|!=)\s*'product'/);
});

test('issue bloqueante ainda aberta nao emite', () => {
  assert.match(finalizer, /status='open' and i\.blocks_ticket_issuance/);
  assert.match(finalizer, /issues_remaining/);
});

test('conflito real de titularidade retorna e registra a causa', () => {
  assert.match(participantReconciliation, /exception when others/);
  assert.match(participantReconciliation, /'error_code', sqlstate, 'error_message', sqlerrm/);
  assert.match(participantReconciliation, /imported_ticket_reconciliation_failed/);
  assert.match(firstAccess, /HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);
});

test('pending continua bloqueado e confirm_all preautorizado pode finalizar pelo titular', () => {
  assert.match(finalizer, /payment_mode_original,'pending'\)='pending' and not p_force_confirm/);
  assert.match(finalizer, /payment_mode_original,'pending'\)='confirm_all'/);
});

test('reconciliacao por usuario inclui vinculo direto e vinculo pelo registration_contact', () => {
  assert.match(userReconciliation, /p\.user_id=p_user_id or rc\.user_id=p_user_id/);
});

test('telas de Cadastros e Ingressos leem tickets como fonte atual e refletem a emissao reconciliada', () => {
  assert.match(cadastrosPage, /from\("tickets"\)/);
  assert.match(ingressosPage, /from\("tickets"\)/);
});
