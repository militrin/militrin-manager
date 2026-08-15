import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

async function environment(){const text=await readFile(new URL('../.env.local',import.meta.url),'utf8');return Object.fromEntries(text.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1).replace(/^['"]|['"]$/g,'')];}));}

test('143 regularizou ticket 449 sem alterar pedido e pagamento',async()=>{
  const env=await environment();
  const supabase=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const ticketId='449195bb-558a-4178-af4c-cf3daa218de1';
  const ticket=await supabase.from('tickets').select('order_id,owner_user_id,participant_id,status').eq('id',ticketId).single(); assert.equal(ticket.error,null,ticket.error?.message);
  const order=await supabase.from('orders').select('user_id,buyer_type,payment_id').eq('id',ticket.data.order_id).single(); assert.equal(order.error,null,order.error?.message);
  const payment=await supabase.from('payments').select('payment_method,payment_status,final_amount').eq('id',order.data.payment_id).single(); assert.equal(payment.error,null,payment.error?.message);
  const audit=await supabase.from('audit_logs').select('details').eq('action','administrative_ticket_owner_regularized').eq('entity_id',ticketId).single(); assert.equal(audit.error,null,audit.error?.message);
  assert.equal(ticket.data.owner_user_id,null); assert.equal(ticket.data.participant_id,null); assert.equal(ticket.data.status,'active');
  assert.equal(order.data.user_id,'e8f5777b-3ed1-409d-b3f1-71724be5a09e'); assert.equal(order.data.buyer_type,'account');
  assert.equal(payment.data.payment_method,'courtesy'); assert.equal(payment.data.payment_status,'paid'); assert.equal(Number(payment.data.final_amount),0);
  assert.equal(audit.data.details.previous_owner_user_id,'e8f5777b-3ed1-409d-b3f1-71724be5a09e'); assert.equal(audit.data.details.new_owner_user_id,null);
});

test('143 expõe buyer_type administrative no schema ativo',async()=>{
  const env=await environment(); const supabase=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const result=await supabase.from('orders').select('id').eq('buyer_type','administrative').limit(1);
  assert.equal(result.error,null,result.error?.message);
});
