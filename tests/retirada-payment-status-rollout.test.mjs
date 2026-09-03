import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isUndefinedDatabaseFunction } from '../src/lib/supabase/missing-rpc.ts';

const pickupActions = await readFile(new URL('../src/app/retirada/actions.ts', import.meta.url), 'utf8');

test('Retirada tenta a RPC nova e so cai no fallback quando a funcao nao existe', () => {
  assert.match(pickupActions, /get_ticket_payment_operational_status/);
  assert.match(pickupActions, /isUndefinedDatabaseFunction\(paymentResult\.error, "get_ticket_payment_operational_status"\)/);
  assert.match(pickupActions, /\.from\("payments"\)[\s\S]*\.select\("payment_status"\)/);
  assert.doesNotMatch(pickupActions, /get_participant_payment_details/);
  assert.doesNotMatch(pickupActions, /pix_code|gateway_payment_id|final_amount|external_payment_id/);
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
