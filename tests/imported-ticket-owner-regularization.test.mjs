import test from 'node:test';
import assert from 'node:assert/strict';
import {readReconciledFile as readFile} from './helpers/read-reconciled-file.mjs';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('140 recalcula owner importado pelo contato e nunca pelo operador',async()=>{
  const sql=await read('../supabase/migrations/140_imported_ticket_owner_regularization.sql');
  assert.match(sql,/buyer_type='imported_holder'/);
  assert.match(sql,/participation_history[\s\S]*ph\.source='import'/);
  assert.match(sql,/import_batches[\s\S]*imported_by/);
  assert.match(sql,/p\.organization_id=e\.organization_id[\s\S]*p\.registration_contact_id=e\.registration_contact_id/);
  assert.match(sql,/join auth\.users au on au\.id=p\.user_id/);
  assert.match(sql,/not\(p\.user_id=any\(e\.imported_by_user_ids\)\)/);
  assert.doesNotMatch(sql,/full_name\s*(=|ilike)|email\s*(=|ilike)|regexp_replace\([^)]*cpf/i);
});

test('140 cobre titular com conta, sem conta, sem titular e ambiguidade',async()=>{
  const sql=await read('../supabase/migrations/140_imported_ticket_owner_regularization.sql');
  assert.match(sql,/case when coalesce\(a\.account_count,0\)=1 then a\.owner_user_id end as expected_owner_user_id/);
  assert.match(sql,/when expected_owner_user_id is null then 'OWNER_DEVE_FICAR_NULL'/);
  assert.match(sql,/OWNER_DEVE_SER_TITULAR_COM_CONTA/);
  assert.match(sql,/holder_account_count>1[\s\S]*IMPORTED_TICKET_OWNER_AMBIGUOUS/);
  assert.match(sql,/new\.owner_user_id:=case when v_holder_account_count=1 then v_expected_owner_user_id else null end/);
});

test('140 altera apenas ticket owner e cria auditoria de regularizacao',async()=>{
  const sql=await read('../supabase/migrations/140_imported_ticket_owner_regularization.sql');
  assert.match(sql,/insert into public\.audit_logs/);
  assert.match(sql,/regularization_import_operator_as_owner/);
  for(const field of ['ticket_id','previous_owner_user_id','new_owner_user_id','import_batch_id','registration_contact_id','holder_account_user_id','imported_by_user_ids','actor_user_id','regularized_at']) assert.match(sql,new RegExp(`'${field}'`));
  assert.match(sql,/update public\.tickets t\s+set owner_user_id=r\.expected_owner_user_id/);
  assert.doesNotMatch(sql,/update public\.(orders|payments|order_items|participants|participant_kit_items)/);
  assert.doesNotMatch(sql,/update public\.tickets[\s\S]{0,100}\b(participant_id|token|status|used_at)\b/);
});

test('trigger futuro prioriza importacao e preserva compra normal por conta',async()=>{
  const sql=await read('../supabase/migrations/140_imported_ticket_owner_regularization.sql');
  const fn=sql.slice(sql.indexOf('create or replace function public.trg_initialize_ticket_owner'));
  assert.ok(fn.indexOf('if v_is_imported then')<fn.indexOf("if v_order.buyer_type='account'"));
  assert.match(fn,/v_order\.import_batch_id/);
  assert.match(fn,/v_order\.buyer_type='imported_holder'/);
  assert.match(fn,/new\.owner_user_id:=v_order\.user_id/);
  assert.match(fn,/IMPORTED_TICKET_OWNER_AMBIGUOUS/);
  assert.match(fn,/before insert on public\.tickets/);
});

test('owner correto nao e regravado e comprador e titular permanecem intactos',async()=>{
  const sql=await read('../supabase/migrations/140_imported_ticket_owner_regularization.sql');
  assert.match(sql,/t\.owner_user_id is distinct from r\.expected_owner_user_id/);
  assert.doesNotMatch(sql,/set\s+(user_id|participant_id|registration_contact_id|buyer_type|import_batch_id)\s*=/i);
  assert.doesNotMatch(sql,/ticket_owner_history/);
});

test('pos-validacao e somente leitura e relata estado final',async()=>{
  const sql=await read('../supabase/plans/140_imported_ticket_owner_post_validation.sql');
  const executable=sql.replace(/--.*$/gm,'');
  for(const field of ['ticket_id','owner_user_id','holder_name','holder_account_user_id','imported_by_user_ids','classification']) assert.match(sql,new RegExp(field));
  assert.match(sql,/AMBIGUO/); assert.match(sql,/OWNER_INCORRETO/); assert.match(sql,/OWNER_E_OPERADOR/); assert.match(sql,/OWNER_CORRETO/);
  assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);
});
