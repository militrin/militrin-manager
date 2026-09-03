import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isUndefinedDatabaseFunction } from '../src/lib/supabase/missing-rpc.ts';

const operationsActions = await readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8');
const retiradaPage = await readFile(new URL('../src/app/retirada/page.tsx', import.meta.url), 'utf8');
const retiradaLayout = await readFile(new URL('../src/app/retirada/layout.tsx', import.meta.url), 'utf8');
const adminMenu = await readFile(new URL('../src/lib/navigation/admin-menu.ts', import.meta.url), 'utf8');
const middleware = await readFile(new URL('../middleware.ts', import.meta.url), 'utf8');
const rbacAudit = await readFile(new URL('../docs/rbac-audit.md', import.meta.url), 'utf8');

test('Central usa a RPC operacional de pagamento e so cai no fallback quando a funcao nao existe', () => {
  assert.match(operationsActions, /get_ticket_payment_operational_status/);
  assert.match(operationsActions, /isUndefinedDatabaseFunction\(paymentResult\.error, "get_ticket_payment_operational_status"\)/);
  assert.match(operationsActions, /\.from\("payments"\)[\s\S]*\.select\("order_id, payment_status, payment_method, created_at"\)/);
  assert.doesNotMatch(operationsActions, /get_participant_payment_details/);
  assert.doesNotMatch(operationsActions, /pix_code|gateway_payment_id|external_payment_id/);
});

test('/retirada nao permanece como tela operacional concorrente', () => {
  assert.match(retiradaPage, /redirect\("\/operacoes"\)/);
  assert.doesNotMatch(retiradaPage, /searchPickupParticipantAction|getPickupTicketAction|Retirada de kits/);
  assert.doesNotMatch(adminMenu, /href: "\/retirada"/);
  assert.match(middleware, /'\/retirada'/);
  assert.match(retiradaLayout, /requireAnyPermission/);
  assert.doesNotMatch(rbacAudit, /\/operacoes`, `\/retirada`/);
  assert.match(rbacAudit, /rota legada de compatibilidade que autentica e redireciona para `\/operacoes`/);
  assert.match(operationsActions, /export async function getOperationCapabilitiesAction/);
  assert.doesNotMatch(operationsActions, /getRetiradaCapabilitiesAction/);
});

test('detector de RPC ausente aceita so 42883/PGRST202 com o nome da funcao', () => {
  assert.equal(
    isUndefinedDatabaseFunction(
      { code: 'PGRST202', message: 'Could not find the function public.get_ticket_payment_operational_status(p_ticket_id) in the schema cache' },
      'get_ticket_payment_operational_status',
    ),
    true,
  );
  assert.equal(
    isUndefinedDatabaseFunction(
      { code: '42883', message: 'function public.get_ticket_payment_operational_status(uuid) does not exist' },
      'get_ticket_payment_operational_status',
    ),
    true,
  );
});

test('detector de RPC ausente nao mascara permissao nem erro de outra funcao', () => {
  assert.equal(
    isUndefinedDatabaseFunction(
      { code: '42501', message: 'permission denied for function get_ticket_payment_operational_status' },
      'get_ticket_payment_operational_status',
    ),
    false,
  );
  assert.equal(
    isUndefinedDatabaseFunction(
      { code: 'P0001', message: 'Sem permissao para consultar o estado operacional do pagamento.' },
      'get_ticket_payment_operational_status',
    ),
    false,
  );
  assert.equal(
    isUndefinedDatabaseFunction(
      { code: 'PGRST202', message: 'Could not find the function public.other_rpc in the schema cache' },
      'get_ticket_payment_operational_status',
    ),
    false,
  );
});
