import test from 'node:test';
import assert from 'node:assert/strict';
import {readReconciledFile as readFile} from './helpers/read-reconciled-file.mjs';
import {buildAdminTransferTicketOwnershipPayload} from '../src/lib/admin/ticket-owner-rpc.ts';
import {contactTicketRoleLabel,rolesForContactTicket} from '../src/lib/registrations/contact-tickets.ts';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('payload de transferencia exige owner, tratamento e motivo estruturado',()=>{
  const ticketId='11111111-1111-4111-8111-111111111111',douglas='22222222-2222-4222-8222-222222222222',bruna='33333333-3333-4333-8333-333333333333';
  const payload=buildAdminTransferTicketOwnershipPayload({ticketId,expectedOwnerUserId:douglas,newOwnerUserId:bruna,holderAction:'keep',reasonCode:'buyer_request'});
  assert.deepEqual(payload,{p_ticket_id:ticketId,p_expected_owner_user_id:douglas,p_new_owner_user_id:bruna,p_holder_action:'keep',p_reason_code:'buyer_request',p_reason_text:null});
  assert.throws(()=>buildAdminTransferTicketOwnershipPayload({ticketId,expectedOwnerUserId:douglas,newOwnerUserId:'',holderAction:'keep',reasonCode:'buyer_request'}),/conta NEXORA/i);
  assert.throws(()=>buildAdminTransferTicketOwnershipPayload({ticketId,expectedOwnerUserId:douglas,newOwnerUserId:bruna,holderAction:'keep',reasonCode:'other'}),/Descreva/i);
});

test('ficha deduplica papeis owner e holder e preserva owner sem titular',()=>{
  const base={ticketId:'t1',eventId:'e1',eventName:'Evento',ownerUserId:'douglas',orderItemContactId:null,participantContactId:null};
  assert.deepEqual(rolesForContactTicket(base,'contact-douglas',['douglas']),['owner']);
  assert.equal(contactTicketRoleLabel(['owner']),'Proprietário');
  const both={...base,orderItemContactId:'contact-douglas'};
  assert.deepEqual(rolesForContactTicket(both,'contact-douglas',['douglas']),['owner','holder']);
  assert.equal(contactTicketRoleLabel(['owner','holder']),'Proprietário e titular');
  const noAccountHolder={...base,ownerUserId:'other',orderItemContactId:'contact-bruna'};
  assert.deepEqual(rolesForContactTicket(noAccountHolder,'contact-bruna',[]),['holder']);
});

test('preflight 139 e somente leitura e classifica todas as origens',async()=>{
  const sql=await read('../supabase/plans/139_ticket_current_ownership_preflight.sql');
  const executable=sql.replace(/--.*$/gm,'');
  for(const classification of ['deterministic_account_buyer','imported_without_account','order_without_buyer','order_missing','buyer_account_missing','organization_inconsistent','ambiguous_buyer_type']) assert.match(sql,new RegExp(classification));
  assert.match(sql,/count\(distinct p\.registration_contact_id\)\s*>\s*1/);
  assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);
});

test('migration 139 separa comprador owner e titular sem inferencia pelo participante',async()=>{
  const sql=await read('../supabase/migrations/139_ticket_current_ownership.sql');
  assert.match(sql,/add column if not exists owner_user_id uuid references auth\.users\(id\) on delete restrict/);
  const backfill=sql.slice(sql.indexOf('update public.tickets t'),sql.indexOf('create or replace function public.trg_initialize_ticket_owner'));
  assert.match(backfill,/o\.buyer_type='account'/); assert.match(backfill,/auth\.users/); assert.doesNotMatch(backfill,/participants|participant_id|registration_contact_id/);
  assert.match(sql,/before insert on public\.tickets/); assert.doesNotMatch(sql,/before insert or update[^;]*initialize_ticket_owner/i);
  assert.match(sql,/drop policy if exists tickets_holder_select/);
  assert.match(sql,/using\(owner_user_id=auth\.uid\(\)\)/);
  assert.match(sql,/tickets\.transfer_ownership/);
});

test('RPC bloqueia concorrencia e altera somente owner mais auditoria',async()=>{
  const sql=await read('../supabase/migrations/139_ticket_current_ownership.sql');
  const fn=sql.slice(sql.indexOf('create or replace function public.admin_transfer_ticket_ownership'),sql.indexOf('revoke all on function'));
  assert.match(fn,/for update/); assert.match(fn,/owner_user_id is distinct from p_expected_owner_user_id/); assert.match(fn,/TICKET_OWNER_CHANGED_CONCURRENTLY/);
  assert.match(fn,/update public\.tickets set owner_user_id=p_new_owner_user_id/);
  assert.match(fn,/ticket_owner_history/); assert.match(fn,/previous_owner_user_id/); assert.match(fn,/actor_user_id/);
  assert.doesNotMatch(fn,/update public\.orders|update public\.payments|update public\.order_items|update public\.participant_kit_items/);
  assert.match(fn,/p_holder_action not in\('keep','assign_new_owner','remove'\)/);
  assert.match(fn,/count\(distinct p\.registration_contact_id\)/); assert.match(fn,/OWNER_CONTACT_AMBIGUOUS/);
  assert.match(fn,/assert_ticket_holder_contact_available|admin_set_ticket_holder_contact/);
});

test('consumidores usam owner e preservam privacidade comercial',async()=>{
  const [portal,actions,detail,cadastro,editor]=await Promise.all([
    read('../src/lib/account/portal-orders-and-tickets.ts'),read('../src/app/minha-conta/actions.ts'),read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),read('../src/app/cadastros/[id]/page.tsx'),read('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx')]);
  assert.match(portal,/\.eq\('owner_user_id', userId\)/); assert.doesNotMatch(portal,/participants!inner\(user_id\)/);
  assert.match(portal,/nao recebe leitura do pedido\/financeiro/); assert.match(actions,/\.eq\('owner_user_id', userId\)/);
  assert.match(detail,/const isOwner/); assert.match(detail,/\(isOwner \|\| canAdminEdit\)/); assert.match(detail,/Proprietário atual/);
  assert.match(cadastro,/rolesForContactTicket/); assert.match(cadastro,/roleLabel/);
  assert.match(editor,/Transferir propriedade/); assert.match(editor,/Manter titular atual/); assert.match(editor,/Definir novo proprietário também como titular/); assert.match(editor,/Deixar sem titular/);
});

test('historico de propriedade mostra transicao motivo ator e data',async()=>{
  const [timeline,taxonomy]=await Promise.all([read('../src/lib/admin/ticket-timeline.ts'),read('../src/lib/admin/ticket-event-taxonomy.ts')]);
  assert.match(timeline,/ticket_owner_history/); assert.match(timeline,/previous_owner_user_id,new_owner_user_id,actor_user_id,reason_code,reason_text,created_at/);
  assert.match(timeline,/id:`owner-/); assert.match(timeline,/sensitiveActionReasonLabel\(row\.reason_code\)/);
  assert.match(taxonomy,/owner_assigned/); assert.match(taxonomy,/owner_transferred/);
});
