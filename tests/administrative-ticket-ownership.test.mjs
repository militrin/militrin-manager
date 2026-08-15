import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql=await readFile(new URL('../supabase/migrations/143_administrative_ticket_ownership.sql',import.meta.url),'utf8');

test('emissao administrativa separa ator comprador owner e titular',()=>{
  assert.match(sql,/buyer_type in\('account','imported_holder','administrative'\)/);
  assert.match(sql,/buyer_type='administrative' and user_id is null and import_batch_id is null/);
  assert.match(sql,/new\.user_id:=null;\s*new\.buyer_type:='administrative'/);
  assert.match(sql,/current_setting\('app\.administrative_ticket_issue_actor',true\)/);
  assert.match(sql,/v_context_actor<>auth\.uid\(\)::text/);
});

test('sem titular fica sem owner e operador nunca e fallback',()=>{
  const unassigned=sql.slice(sql.indexOf('for v_index in v_index..p_quantity loop'),sql.indexOf('-- Regularizacao estritamente'));
  assert.match(unassigned,/update public\.tickets set owner_user_id=null/);
  assert.doesNotMatch(unassigned,/owner_user_id\s*=\s*v_actor/);
  assert.match(unassigned,/'assign_holder',false/);
  assert.match(unassigned,/'owner_user_id',null/);
});

test('titular sem conta fica null e com conta inequivoca recebe essa conta',()=>{
  assert.match(sql,/count\(distinct p\.user_id\)/);
  assert.match(sql,/if v_count>1 then\s*raise exception 'ADMINISTRATIVE_TICKET_OWNER_AMBIGUOUS/);
  assert.match(sql,/return case when v_count=1 then v_owner else null end/);
  assert.match(sql,/v_owner_user_id:=public\.resolve_administrative_ticket_owner/);
  assert.match(sql,/update public\.tickets set owner_user_id=v_owner_user_id/);
});

test('142 permanece compativel com courtesy system_failure ator e atomicidade',()=>{
  assert.match(sql,/v_issue_reason not in\('courtesy','system_failure','administrative_correction','other'\)/);
  assert.match(sql,/v_financial_method constant text:='courtesy'/);
  assert.match(sql,/'actor_user_id',v_actor/);
  assert.match(sql,/'issue_reason',v_issue_reason/);
  assert.match(sql,/'payment_method',v_financial_method/);
  assert.match(sql,/begin;[\s\S]*commit;/);
});

test('ticket comprovado tem regularizacao isolada sem alterar pedido ou pagamento',()=>{
  const regularization=sql.slice(sql.indexOf('-- Regularizacao estritamente'));
  assert.match(regularization,/449195bb-558a-4178-af4c-cf3daa218de1/);
  assert.match(regularization,/ADMINISTRATIVE_OWNER_REGULARIZATION_PRECONDITION_FAILED/);
  assert.match(regularization,/administrative_ticket_owner_regularized/);
  assert.match(regularization,/update public\.tickets set owner_user_id=null/);
  assert.doesNotMatch(regularization,/update public\.orders/);
  assert.doesNotMatch(regularization,/update public\.payments/);
});

test('precedencia de importacao da 140 permanece antes da origem administrativa',()=>{
  const imported=sql.indexOf('if v_is_imported then');
  const administrative=sql.indexOf("if v_order.buyer_type='administrative' then");
  assert.ok(imported>=0&&administrative>imported);
  assert.match(sql,/not\(p\.user_id=any\(v_imported_by_user_ids\)\)/);
});
