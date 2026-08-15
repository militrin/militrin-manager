import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

async function environment(){
  const text=await readFile(new URL('../.env.local',import.meta.url),'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{
    const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1).replace(/^['"]|['"]$/g,'')];
  }));
}

test('efeitos exclusivos da 142 estao ativos e expõem a causa do owner administrativo',async()=>{
  const env=await environment();
  const supabase=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const ticketId='449195bb-558a-4178-af4c-cf3daa218de1';
  const ticket=await supabase.from('tickets').select('id,order_id,order_item_id,participant_id,owner_user_id,status').eq('id',ticketId).single();
  assert.equal(ticket.error,null,ticket.error?.message);
  const order=await supabase.from('orders').select('id,user_id,buyer_type,payment_id').eq('id',ticket.data.order_id).single();
  assert.equal(order.error,null,order.error?.message);
  const item=await supabase.from('order_items').select('participant_id,registration_contact_id,ownership_status').eq('id',ticket.data.order_item_id).single();
  assert.equal(item.error,null,item.error?.message);
  const payment=await supabase.from('payments').select('payment_method,payment_status,final_amount').eq('id',order.data.payment_id).single();
  assert.equal(payment.error,null,payment.error?.message);
  const audit=await supabase.from('audit_logs').select('details,created_at').eq('action','manual_ticket_issued').eq('entity_id',ticketId).single();
  assert.equal(audit.error,null,audit.error?.message);
  assert.deepEqual({issue_reason:audit.data.details.issue_reason,payment_method:audit.data.details.payment_method,assign_holder:audit.data.details.assign_holder},
    {issue_reason:'system_failure',payment_method:'courtesy',assign_holder:false});
  assert.equal(payment.data.payment_method,'courtesy');
  assert.equal(payment.data.payment_status,'paid');
  assert.equal(Number(payment.data.final_amount),0);
  assert.equal(ticket.data.status,'active');
  assert.equal(ticket.data.participant_id,null);
  assert.equal(item.data.participant_id,null);
  assert.equal(item.data.registration_contact_id,null);
  assert.equal(item.data.ownership_status,'unassigned');
  assert.equal(order.data.buyer_type,'account');
  assert.equal(ticket.data.owner_user_id,order.data.user_id);
  assert.equal(audit.data.details.actor_user_id,order.data.user_id);
});
