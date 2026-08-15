import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

async function environment() {
  const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => { const index=line.indexOf('='); return [line.slice(0,index),line.slice(index+1).replace(/^['"]|['"]$/g,'')]; }));
}

async function required(label, query) {
  const result = await query;
  assert.equal(result.error, null, `${label}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  return result.data;
}

test('consultas reais da timeline correspondem ao esquema ativo', async () => {
  const env=await environment();
  const supabase=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const ticketId='86825375-30c1-4e82-83ac-be080b2b1a5c';
  const ticket=await required('ticket',supabase.from('tickets').select('id,status,issued_at,used_at,cancelled_at,event_id,organization_id,participant_id,order_id,order_item_id').eq('id',ticketId).single());
  const item=await required('order-item',supabase.from('order_items').select('id,order_id,participant_id,event_id').eq('id',ticket.order_item_id).single());
  const order=await required('order',supabase.from('orders').select('id,order_number,confirmed_at,payment_id,event_id,organization_id').eq('id',item.order_id).single());
  await required('payment',supabase.from('payments').select('id,paid_at,payment_status,event_id,organization_id').eq('id',order.payment_id).single());
  await required('participant',supabase.from('participants').select('id,full_name,event_id,organization_id').eq('id',ticket.participant_id).single());
  await required('event',supabase.from('events').select('id,name,organization_id').eq('id',ticket.event_id).single());
  await required('kit-links',supabase.from('participant_kit_items').select('id').eq('ticket_id',ticketId));
  const audits=await required('audit-logs',supabase.from('audit_logs').select('id,action,entity_type,entity_id,event_id,details,created_at').eq('event_id',ticket.event_id).eq('entity_type','tickets').eq('entity_id',ticketId).order('created_at'));
  // This ticket belongs to a shared remote environment and can legitimately gain
  // unrelated audit events. Assert only the facts owned by this fixture.
  assert.equal(audits.filter(row=>row.action==='ticket_issued').length,1);
  const shirtAudits=audits.filter(row=>row.action==='ticket_shirt_admin_changed');
  const variantIds=shirtAudits.map(row=>row.details.variant_id);
  const variants=await required('shirt-variants',supabase.from('event_kit_item_variants').select('id,name,value').in('id',variantIds));
  const variantLabels=new Set(variants.map(row=>`${row.name}/${row.value}`));
  assert.equal(variantLabels.has('Babylook/EXG'),true);
  assert.equal(variantLabels.has('Camiseta/PP'),true);
  await required('holder-history',supabase.from('ticket_holder_history').select('id,operation,previous_participant_id,new_participant_id,previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason,created_at').eq('ticket_id',ticketId).eq('organization_id',ticket.organization_id).limit(1));
  await required('item-change-requests',supabase.from('ticket_item_change_requests').select('id,status,current_variant,requested_variant,requested_at,reviewed_at,reason,review_notes').eq('ticket_id',ticketId).eq('organization_id',ticket.organization_id).limit(1));
  assert.equal(order.id,item.order_id);
});
