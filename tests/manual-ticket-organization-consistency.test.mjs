import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('141 centraliza emissao final de ticket com organizacao do evento',async()=>{
  const sql=await read('../supabase/migrations/141_manual_ticket_issue_organization_consistency.sql');
  const fn=sql.slice(sql.indexOf('create or replace function public.confirm_order_item_and_issue_ticket'),sql.indexOf('-- Corrige a dependencia'));
  assert.match(fn,/select \* into v_event from public\.events where id=v_item\.event_id/);
  assert.match(fn,/v_order\.organization_id is distinct from v_event\.organization_id/);
  assert.match(fn,/insert into public\.tickets\(order_id,order_item_id,participant_id,event_id,organization_id,status\)/);
  assert.match(fn,/v_order\.id,v_item\.id,v_item\.participant_id,v_event\.id,v_event\.organization_id,'active'/);
  assert.match(fn,/organization_id=excluded\.organization_id/);
});

test('com e sem titular usam a mesma funcao e vazio permanece unassigned',async()=>{
  const [migration,batch]=await Promise.all([read('../supabase/migrations/141_manual_ticket_issue_organization_consistency.sql'),read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql')]);
  assert.match(batch,/create_manual_registration_order/);
  assert.match(batch,/create_manual_unassigned_ticket_order/);
  assert.match(batch,/if coalesce\(p_assign_holder,true\)/);
  assert.match(migration,/v_item\.participant_id/);
  const unassigned=batch.slice(batch.indexOf('create_manual_unassigned_ticket_order'));
  assert.doesNotMatch(unassigned,/update public\.registration_contacts/);
});

test('trigger owner aceita org ainda nula e continua protegendo divergencia real',async()=>{
  const sql=await read('../supabase/migrations/141_manual_ticket_issue_organization_consistency.sql');
  const fn=sql.slice(sql.indexOf('create or replace function public.trg_initialize_ticket_owner'));
  assert.match(fn,/if new\.organization_id is null then\s+new\.organization_id:=v_order\.organization_id/);
  assert.match(fn,/elsif new\.organization_id is distinct from v_order\.organization_id/);
  assert.ok(fn.indexOf('new.organization_id:=v_order.organization_id')<fn.indexOf("v_order.buyer_type='account'"));
  assert.match(fn,/v_is_imported/);
});

test('emissao valida evento organizacao e pagamento antes do insert',async()=>{
  const sql=await read('../supabase/migrations/141_manual_ticket_issue_organization_consistency.sql');
  assert.match(sql,/Evento do item diverge do evento do pedido/);
  assert.match(sql,/Organizacao do pedido diverge da organizacao do evento/);
  assert.match(sql,/Pagamento diverge do evento ou organizacao da emissao/);
  assert.doesNotMatch(sql,/update public\.(registration_contacts|participants|orders|payments|participant_kit_items)/);
});

test('preflight 141 e somente leitura',async()=>{
  const sql=await read('../supabase/plans/141_manual_ticket_issue_organization_preflight.sql');
  const executable=sql.replace(/--.*$/gm,'');
  assert.match(sql,/ticket_organization_id/); assert.match(sql,/order_organization_id/); assert.match(sql,/event_organization_id/);
  assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);
});
