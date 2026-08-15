import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';
import { buildAdminSetTicketHolderPayload } from '../src/lib/admin/ticket-holder-rpc.ts';
import { sensitiveActionReasonLabel, validateSensitiveActionReason } from '../src/lib/admin/sensitive-action-reasons.ts';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');
const ticket='dec6d451-27c1-423d-8ac1-657ee8b0feb9';

test('motivo predefinido gera argumentos da nova assinatura',()=>{
  assert.deepEqual(buildAdminSetTicketHolderPayload(ticket,null,'system_error','Falha importada'),{
    p_ticket_id:ticket,p_registration_contact_id:null,p_reason_code:'system_error',p_reason_text:'Falha importada',
  });
  assert.equal(sensitiveActionReasonLabel('system_error'),'Falha do sistema');
});

test('other exige texto e aceita descricao preenchida',()=>{
  assert.throws(()=>validateSensitiveActionReason('other','  '),/Descreva o motivo/);
  assert.deepEqual(validateSensitiveActionReason('other',' Caso excepcional '),{reasonCode:'other',reasonText:'Caso excepcional'});
});

test('migration 138 preserva legado, deriva ator da sessao e nao altera dominios adjacentes',async()=>{
  const sql=await read('../supabase/migrations/138_ticket_holder_reason_taxonomy.sql');
  assert.match(sql,/add column if not exists reason_code text/);
  assert.match(sql,/add column if not exists reason_text text/);
  assert.match(sql,/ticket_holder_history_new_reason_required_check[\s\S]*check\(reason_code is not null\) not valid/);
  assert.doesNotMatch(sql,/update public\.ticket_holder_history set reason_code/);
  assert.match(sql,/v_actor uuid:=auth\.uid\(\)/);
  assert.match(sql,/if v_actor is null then raise exception 'Usuario nao autenticado\.'/);
  assert.match(sql,/current_user_has_permission\('participants\.edit_basic'\)/);
  assert.doesNotMatch(sql,/p_actor|actor_user_id uuid default|coalesce\([^\n]*auth\.uid/);
  assert.doesNotMatch(sql,/update public\.(orders|payments|participant_kit_items|event_kit_items)/);
});

test('nova RPC grava auditoria completa, suporta titular sem conta e remocao',async()=>{
  const sql=await read('../supabase/migrations/138_ticket_holder_reason_taxonomy.sql');
  assert.match(sql,/admin_set_ticket_holder_contact\([\s\S]*p_reason_code text,p_reason_text text default null/);
  assert.match(sql,/'reason_code',v_reason_code,'reason_text',v_reason_text/);
  assert.match(sql,/'previous_user_id',v_previous\.user_id,'new_user_id',v_target\.user_id/);
  assert.match(sql,/values\(v_ticket\.event_id,v_ticket\.organization_id,v_contact\.id,null/);
  assert.match(sql,/'holder_removed'/);
  assert.match(sql,/'holder_changed'/);
  assert.match(sql,/update public\.order_items set participant_id=null,registration_contact_id=null/);
  assert.match(sql,/update public\.tickets set participant_id=null/);
});

test('wrapper antigo permanece funcional e explicitamente nao classificado',async()=>{
  const sql=await read('../supabase/migrations/138_ticket_holder_reason_taxonomy.sql');
  assert.match(sql,/admin_set_ticket_holder_contact\(p_ticket_id uuid,p_registration_contact_id uuid,p_reason text\)/);
  assert.match(sql,/'legacy_unclassified',nullif\(trim\(coalesce\(p_reason,''\)/);
  assert.match(sql,/if nullif\(trim\(coalesce\(p_reason,''\)\),''\) is null then raise exception 'Motivo obrigatorio\.'/);
});

test('frontend usa select compartilhado, other condicional e assinatura nova',async()=>{
  const [editor,actions]=await Promise.all([
    read('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx'),read('../src/app/ingressos/[ticketId]/editar/actions.ts'),
  ]);
  assert.match(editor,/SENSITIVE_ACTION_REASON_OPTIONS\.map/);
  assert.match(editor,/<select/);
  assert.match(editor,/code === "other" \?/);
  assert.match(editor,/reasonCode === "other" && !reasonText\.trim\(\)/);
  assert.match(editor,/removeReasonCode === "other" && !removeReasonText\.trim\(\)/);
  const reasonFields=editor.slice(editor.indexOf('function ReasonFields'));
  assert.doesNotMatch(reasonFields,/<textarea/);
  assert.match(actions,/buildAdminSetTicketHolderPayload\(ticketId, registrationContactId, reasonCode, reasonText\)/);
});

test('timeline mostra nomes, motivo, observacao, ator e horario',async()=>{
  const [timeline,panel,taxonomy]=await Promise.all([
    read('../src/lib/admin/ticket-timeline.ts'),read('../src/app/ingressos/[ticketId]/timeline-panel.tsx'),read('../src/lib/admin/ticket-event-taxonomy.ts'),
  ]);
  assert.match(timeline,/reason_code,reason_text/);
  assert.match(timeline,/holderNames/);
  assert.match(timeline,/operatorNames\.get/);
  assert.match(timeline,/sensitiveActionReasonLabel\(row\.reason_code\)/);
  assert.match(timeline,/observation: row\.reason_text/);
  assert.match(panel,/Realizado por:/);
  assert.match(panel,/Observação:/);
  assert.match(panel,/formatReportDateTime\(event\.occurredAt\)/);
  assert.match(taxonomy,/holder_changed: \{ label: "Titular alterado"/);
});
