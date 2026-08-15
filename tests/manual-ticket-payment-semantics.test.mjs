import test from 'node:test';
import assert from 'node:assert/strict';
import {readReconciledFile as readFile} from './helpers/read-reconciled-file.mjs';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('constraint financeira aceita somente metodos canonicos',async()=>{
  const sql=await read('../supabase/migrations/013_payments_module.sql');
  assert.match(sql,/payments_method_check/);
  for(const method of ['pix','credit_card','cash','courtesy']) assert.match(sql,new RegExp(`'${method}'`));
  assert.doesNotMatch(sql,/system_failure|administrative_correction/);
});

test('142 separa todos os motivos do metodo courtesy',async()=>{
  const sql=await read('../supabase/migrations/142_manual_ticket_issue_reason_payment_semantics.sql');
  for(const reason of ['courtesy','system_failure','administrative_correction','other']) assert.match(sql,new RegExp(`'${reason}'`));
  assert.match(sql,/v_financial_method constant text:='courtesy'/);
  assert.match(sql,/create_manual_registration_order[\s\S]*v_financial_method,p_notes/);
  assert.match(sql,/create_manual_unassigned_ticket_order[\s\S]*v_financial_method,p_notes/);
  assert.doesNotMatch(sql,/create_manual_(registration_order|unassigned_ticket_order)[\s\S]{0,300}v_issue_reason/);
});

test('motivo permanece auditavel para emissao com e sem titular',async()=>{
  const sql=await read('../supabase/migrations/142_manual_ticket_issue_reason_payment_semantics.sql');
  assert.match(sql,/manual_ticket_issued/);
  assert.match(sql,/'issue_reason',v_issue_reason/);
  assert.match(sql,/'payment_method',v_financial_method/);
  assert.match(sql,/'assign_holder',true/);
  assert.match(sql,/'assign_holder',false/);
  assert.match(sql,/v_issue_reason='other'[\s\S]*p_notes/);
});

test('validacoes precedem mutacoes e falha e atomica',async()=>{
  const sql=await read('../supabase/migrations/142_manual_ticket_issue_reason_payment_semantics.sql');
  const firstMutation=sql.indexOf('select * into v_first');
  assert.ok(sql.indexOf('Motivo de emissao manual invalido')<firstMutation);
  assert.ok(sql.indexOf('Cadastro nao pertence a organizacao do evento')<firstMutation);
  assert.match(sql,/begin;[\s\S]*commit;/);
});

test('frontend envia motivo e oferece correcao administrativa',async()=>{
  const [action,form]=await Promise.all([read('../src/app/ingressos/emitir/actions.ts'),read('../src/app/ingressos/emitir/issue-ticket-form.tsx')]);
  assert.match(action,/administrative_correction/);
  assert.match(action,/p_payment_method: input\.reason/);
  assert.match(form,/Correção administrativa/);
});
