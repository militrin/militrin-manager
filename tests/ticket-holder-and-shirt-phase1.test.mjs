import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';
import { buyerOwnershipModes, shouldAssignBuyerToNewOrder } from '../src/lib/registrations/active-ticket-holder.ts';
import { buildAdminSetTicketHolderPayload } from '../src/lib/admin/ticket-holder-rpc.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('unicidade usa registration_contact por evento, lock e ignora cancelados', async () => {
  const sql = await read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql');
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /registration_contact_id/);
  assert.match(sql, /HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);
  assert.match(sql, /t\.event_id=p_event_id/);
  assert.match(sql, /t\.id is distinct from p_exclude_ticket_id/);
  assert.match(sql, /not in\s*\('cancelled','canceled','void','voided'\)/);
  assert.match(sql, /before insert or update of participant_id,event_id,status,order_item_id on public\.tickets/);
  assert.match(sql, /before update of participant_id,registration_contact_id,event_id on public\.order_items/);
});

test('titular sem conta, remocao e historico contact-first sao suportados', async () => {
  const [sql,actions,editor,timeline] = await Promise.all([
    read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql'),
    read('../src/app/ingressos/[ticketId]/editar/actions.ts'),
    read('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx'),
    read('../src/lib/admin/ticket-timeline.ts'),
  ]);
  assert.match(sql,/alter column new_user_id drop not null/);
  assert.match(sql,/previous_registration_contact_id/);
  assert.match(sql,/new_registration_contact_id/);
  assert.match(sql,/admin_set_ticket_holder_contact\(p_ticket_id uuid,p_registration_contact_id uuid/);
  assert.match(sql,/v_contact\.id,null,v_contact\.full_name/);
  assert.match(sql,/holder_removed/);
  assert.match(sql,/participant_id=null,registration_contact_id=null/);
  assert.match(sql,/new_registration_contact_id[\s\S]*new_user_id/);
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(actions,/admin_set_ticket_holder_contact/);
  assert.match(editor,/registration_contact_id/);
  assert.match(editor,/Sem conta/);
  assert.match(editor,/Remover titular/);
  assert.match(timeline,/previous_registration_contact_id,new_registration_contact_id/);
});

test('mudanca de titular nao altera comprador do pedido', async () => {
  const sql = await read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql');
  const fn = sql.slice(sql.indexOf('create or replace function public.admin_set_ticket_holder_contact'), sql.indexOf('create or replace function public.admin_transfer_ticket_holder'));
  assert.doesNotMatch(fn,/update public\.orders|set user_id/);
  assert.match(fn,/update public\.order_items/);
  assert.match(fn,/update public\.tickets/);
});

test('camiseta e materializada automaticamente com variante canonica e idempotencia', async () => {
  const [sql,detail,operations,pickup] = await Promise.all([
    read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql'),
    read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),
    read('../src/app/operacoes/actions.ts'), read('../src/app/retirada/actions.ts'),
  ]);
  assert.match(sql, /create or replace function public\.ensure_ticket_kit_items/);
  assert.match(sql, /'variant_id',v_variant\.id/);
  assert.match(sql, /set variant_data=coalesce\(variant_data,'\{\}'::jsonb\)\|\|jsonb_build_object/);
  assert.match(sql, /with deterministic_shirt_variants as/);
  assert.match(sql, /having count\(\*\)=1/);
  assert.match(sql, /nullif\(v_link_variant_data->>'variant_id',''\) is not null/);
  assert.match(sql, /create or replace function public\.materialize_ticket_kit_items_internal/);
  assert.match(sql, /v_result:=public\.ensure_ticket_kit_items\(p_ticket_id\)/);
  assert.match(sql, /on conflict\(ticket_id,kit_item_id\).*do nothing/s);
  for (const source of [detail,operations,pickup]) assert.match(source, /ensure_ticket_kit_items/);
  assert.doesNotMatch(detail, /Confirmar vínculo|vínculo operacional/);
});

test('acoes contextuais abrem dialogs reais e reutilizam server actions', async () => {
  const [detail,actions] = await Promise.all([
    read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),
    read('../src/app/minha-conta/ingressos/[ticketId]/ticket-context-actions.tsx'),
  ]);
  assert.match(detail, /HolderContextAction/); assert.match(detail, /CategoryContextAction/); assert.match(detail, /ShirtContextAction/);
  assert.match(actions, /role="dialog"/); assert.match(actions, /updateTicketCategoryAction/); assert.match(actions, /adminChangeTicketShirtAction/);
  assert.doesNotMatch(detail, /href="#admin-(holder|category|shirt)"/);
});

test('comprador e titular aparecem separados sem fallback na ficha do cadastro', async () => {
  const [ticket,cadastro] = await Promise.all([read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),read('../src/app/cadastros/[id]/page.tsx')]);
  assert.match(ticket, /Comprador:/); assert.match(ticket, /Titular:/);
  assert.match(cadastro, /row\.participant_id \|\| orderItem\?\.participant_id/);
  assert.match(cadastro, /Titular não definido/);
});

test('diagnostico de conflitos e estritamente somente leitura', async () => {
  const sql = await read('../supabase/plans/137_ticket_holder_conflicts_diagnostic.sql');
  const executable = sql.replace(/--.*$/gm,'');
  assert.match(sql,/ticket_count/); assert.match(sql,/buyer_user_id/); assert.match(sql,/holder_full_name/); assert.match(sql,/import_batch_id/); assert.match(sql,/issued_at/);
  assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);
});

test('checkout usa uma unica decisao de autoatribuicao para qualquer quantidade', async () => {
  assert.equal(shouldAssignBuyerToNewOrder(true,false),true);
  assert.equal(shouldAssignBuyerToNewOrder(true,true),false);
  assert.equal(shouldAssignBuyerToNewOrder(false,false),false);
  assert.deepEqual(buyerOwnershipModes(1,true,false),['self']);
  assert.deepEqual(buyerOwnershipModes(1,true,true),['unassigned']);
  assert.deepEqual(buyerOwnershipModes(3,true,false),['self','unassigned','unassigned']);
  assert.deepEqual(buyerOwnershipModes(3,true,true),['unassigned','unassigned','unassigned']);
  const actions=await read('../src/app/inscricao/actions.ts');
  assert.doesNotMatch(actions,/quantity > 1[\s\S]{0,500}existingTicketCount/);
  assert.match(actions,/registrationContactHasActiveTicket/);
  assert.match(actions,/ownership_mode: 'unassigned'/);
});

test('emissao administrativa exige decisao explicita e pode emitir todo o lote sem titular', async () => {
  const [actions,form,migration]=await Promise.all([
    read('../src/app/ingressos/emitir/actions.ts'),read('../src/app/ingressos/emitir/issue-ticket-form.tsx'),
    read('../supabase/migrations/135_atomic_manual_ticket_batch_issue.sql'),
  ]);
  assert.match(actions,/Esta pessoa já é titular de outro ingresso neste evento/);
  assert.match(actions,/p_assign_holder: assignHolder/);
  assert.match(form,/Emitir sem titular/); assert.match(form,/Cancelar/);
  assert.match(migration,/p_assign_holder boolean default true/);
  assert.match(migration,/HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);
  assert.match(migration,/v_index:=1/);
  const holderMigration=await read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql');
  assert.match(holderMigration,/create or replace function public\.issue_manual_ticket_batch/);
  assert.match(holderMigration,/assert_ticket_holder_contact_available\(null,p_event_id,v_contact\.id\)/);
  assert.match(holderMigration,/issue_manual_ticket_batch\(uuid,uuid,uuid,uuid,integer,text,text,text,text,text\) from public,anon,authenticated/);
});

test('137 mantem garantia concorrente e semantica canonica de status', async () => {
  const sql=await read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql');
  assert.match(sql,/registration_contact_has_active_ticket/);
  assert.match(sql,/returns boolean language sql volatile security definer/);
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/not in\('cancelled','canceled','void','voided'\)/);
});

test('Douglas para Bruna envia os tres argumentos canonicos sem omitir o contato',()=>{
  assert.deepEqual(buildAdminSetTicketHolderPayload(
    'dec6d451-27c1-423d-8ac1-657ee8b0feb9','456a80f3-a67e-4651-900d-e94ca96a5dca','system_error','Falha identificada',
  ),{
    p_ticket_id:'dec6d451-27c1-423d-8ac1-657ee8b0feb9',
    p_registration_contact_id:'456a80f3-a67e-4651-900d-e94ca96a5dca',
    p_reason_code:'system_error',p_reason_text:'Falha identificada',
  });
});

test('remocao envia null explicito e undefined e rejeitado antes da RPC',()=>{
  assert.deepEqual(buildAdminSetTicketHolderPayload(
    'dec6d451-27c1-423d-8ac1-657ee8b0feb9',null,'buyer_request',null,
  ),{
    p_ticket_id:'dec6d451-27c1-423d-8ac1-657ee8b0feb9',p_registration_contact_id:null,p_reason_code:'buyer_request',p_reason_text:null,
  });
  assert.throws(()=>buildAdminSetTicketHolderPayload('dec6d451-27c1-423d-8ac1-657ee8b0feb9',undefined,'buyer_request'),/Selecione um cadastro válido/);
});

test('remocao administrativa usa dialog proprio, action canonica e atualiza a ficha', async()=>{
  const [editor,actions,page,sql]=await Promise.all([
    read('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/actions.ts'),
    read('../src/app/ingressos/[ticketId]/editar/page.tsx'),
    read('../supabase/migrations/137_ticket_holder_uniqueness_and_auto_shirt_link.sql'),
  ]);
  assert.match(editor,/role="dialog"/);
  assert.match(editor,/Remover \{displayedHolder\} como titular deste ingresso\?/);
  assert.match(editor,/code=\{removeReasonCode\} text=\{removeReasonText\}/);
  assert.match(editor,/transferTicketHolderAction\(props\.ticketId, null, removeReasonCode, removeReasonText\)/);
  assert.doesNotMatch(editor,/transferTicketHolderAction\(props\.ticketId, undefined/);
  assert.match(editor,/setRemoveDialogOpen\(true\)/);
  assert.match(editor,/setRemoveDialogOpen\(false\)/);
  assert.match(editor,/setDisplayedHolder\("Titular não definido"\)/);
  assert.match(editor,/router\.refresh\(\)/);
  assert.match(editor,/Não foi possível remover o titular/);
  assert.match(actions,/admin_set_ticket_holder_contact/);
  assert.match(actions,/buildAdminSetTicketHolderPayload\(ticketId, registrationContactId, reasonCode, reasonText\)/);
  assert.match(actions,/Não foi possível alterar o titular/);
  assert.match(page,/currentHolder=\{holder\?\.full_name \?\? "Titular não definido"\}/);

  const fn=sql.slice(sql.indexOf('create or replace function public.admin_set_ticket_holder_contact'),sql.indexOf('create or replace function public.admin_transfer_ticket_holder'));
  assert.doesNotMatch(fn,/update public\.orders|update public\.payments|update public\.event_kit_items/);
  assert.match(fn,/update public\.order_items set participant_id=null,registration_contact_id=null/);
  assert.match(fn,/update public\.tickets set participant_id=null/);
  assert.match(fn,/'holder_removed'/);
});
