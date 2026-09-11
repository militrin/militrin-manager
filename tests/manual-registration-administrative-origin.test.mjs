import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(
  new URL('../supabase/migrations/20261021000000_manual_registration_administrative_buyer_type.sql', import.meta.url),
  'utf8',
);
const checkoutSql = await readFile(
  new URL('../supabase/migrations/20260904000000_ticket_category_capacity_order_items_source.sql', import.meta.url),
  'utf8',
);
const novaAction = await readFile(
  new URL('../src/app/inscricoes/nova/actions.ts', import.meta.url),
  'utf8',
);

const fn = sql.slice(
  sql.indexOf('create or replace function public.create_manual_registration_order'),
  sql.indexOf('commit;'),
);

test('create_manual_registration_order reusa o GUC de emissao administrativa antes do insert', () => {
  const gucIndex = fn.indexOf("set_config('app.administrative_ticket_issue_actor'");
  const insertIndex = fn.indexOf('insert into public.orders');
  assert.ok(gucIndex >= 0, 'precisa setar app.administrative_ticket_issue_actor');
  assert.ok(insertIndex > gucIndex, 'GUC precisa preceder o insert do pedido');
  assert.match(fn, /v_actor::text/);
  assert.doesNotMatch(sql, /update public\.orders[\s\S]{0,200}buyer_type\s*=/);
});

test('insert continua pelo trigger existente, sem segunda regra paralela de buyer_type', () => {
  assert.match(fn, /buyer_type,confirmed_at\)\s*values\(v_actor,v_participant\.id,p_event_id,v_event\.organization_id,public\.generate_order_number\(\),'confirmed',v_base,v_base,0,'account',now\(\)/);
  assert.match(sql, /trg_classify_administrative_order/);
  assert.doesNotMatch(fn, /buyer_type\s*=\s*'administrative'/);
});

test('/inscricoes/nova continua chamando a mesma RPC, sem classificacao no client', () => {
  assert.match(novaAction, /supabase\.rpc\('create_manual_registration_order'/);
  assert.doesNotMatch(novaAction, /buyer_type/);
  assert.doesNotMatch(novaAction, /administrative_ticket_issue_actor/);
});

test('checkout publico nao seta o GUC administrativo', () => {
  assert.doesNotMatch(checkoutSql, /administrative_ticket_issue_actor/);
});

test('migration nao faz backfill de pedidos historicos', () => {
  assert.doesNotMatch(sql, /update public\.orders[\s\S]{0,120}buyer_type\s*=/);
  assert.match(sql, /Sem backfill/);
});
