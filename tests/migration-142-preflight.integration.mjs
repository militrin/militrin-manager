import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

async function environment() {
  const text=await readFile(new URL('../.env.local',import.meta.url),'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{
    const index=line.indexOf('=');
    return [line.slice(0,index),line.slice(index+1).replace(/^['"]|['"]$/g,'')];
  }));
}

test('banco remoto contém as precondições das migrations 138 a 141',async()=>{
  const env=await environment();
  const supabase=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

  const holderHistory=await supabase.from('ticket_holder_history').select('reason_code,reason_text').limit(1);
  assert.equal(holderHistory.error,null,`138: ${holderHistory.error?.message??''}`);

  const owners=await supabase.from('tickets').select('owner_user_id').limit(1);
  assert.equal(owners.error,null,`139 owner_user_id: ${owners.error?.message??''}`);
  const ownerHistory=await supabase.from('ticket_owner_history').select('actor_user_id,reason_code,reason_text').limit(1);
  assert.equal(ownerHistory.error,null,`139 ticket_owner_history: ${ownerHistory.error?.message??''}`);

  const regularization=await supabase.from('audit_logs').select('id',{count:'exact',head:true}).eq('action','imported_ticket_owner_regularized');
  assert.equal(regularization.error,null,`140 audit: ${regularization.error?.message??''}`);
  assert.ok((regularization.count??0)>0,'140 deve ter registrado regularizações auditáveis');

  const required=async(label,query)=>{
    const result=await query;
    assert.equal(result.error,null,`${label}: ${result.error?.message??''}`);
    return result.data??[];
  };
  const [tickets,orders,items,participants,batches,history]=await Promise.all([
    required('140 tickets',supabase.from('tickets').select('id,order_id,order_item_id,participant_id,event_id,organization_id,owner_user_id,issued_at')),
    required('140 orders',supabase.from('orders').select('id,user_id,buyer_type,import_batch_id,participant_id,created_at')),
    required('140 items',supabase.from('order_items').select('id,participant_id,registration_contact_id')),
    required('140 participants',supabase.from('participants').select('id,organization_id,registration_contact_id,user_id')),
    required('140 batches',supabase.from('import_batches').select('id,imported_by')),
    required('140 participation history',supabase.from('participation_history').select('participant_id,import_batch_id,source').eq('source','import')),
  ]);
  const validUsers=new Set();
  for(let page=1;;page+=1){
    const result=await supabase.auth.admin.listUsers({page,perPage:1000});
    assert.equal(result.error,null,`140 auth.users: ${result.error?.message??''}`);
    for(const user of result.data.users)validUsers.add(user.id);
    if(result.data.users.length<1000)break;
  }
  const orderById=new Map(orders.map(row=>[row.id,row]));
  const itemById=new Map(items.map(row=>[row.id,row]));
  const participantById=new Map(participants.map(row=>[row.id,row]));
  const batchById=new Map(batches.map(row=>[row.id,row]));
  let importedCount=0,incorrectCount=0,ambiguousCount=0,incorrectToNull=0,incorrectToAccount=0,ownerIsImporter=0;
  const incorrectRecords=[];
  const importedRecords=[];
  for(const ticket of tickets){
    const order=orderById.get(ticket.order_id); if(!order)continue;
    const item=itemById.get(ticket.order_item_id);
    const holderId=item?.participant_id??ticket.participant_id;
    const holder=participantById.get(holderId);
    const evidence=new Set();
    if(order.import_batch_id&&batchById.has(order.import_batch_id))evidence.add(order.import_batch_id);
    for(const row of history)if(((order.participant_id!==null&&order.participant_id!==undefined&&row.participant_id===order.participant_id)||(holderId!==null&&holderId!==undefined&&row.participant_id===holderId))&&batchById.has(row.import_batch_id))evidence.add(row.import_batch_id);
    const imported=order.buyer_type==='imported_holder'||evidence.size>0; if(!imported)continue;
    importedCount+=1;
    const importers=new Set([...evidence].map(id=>batchById.get(id)?.imported_by).filter(Boolean));
    const contactId=item?.registration_contact_id??holder?.registration_contact_id;
    const accounts=new Set(participants.filter(row=>row.organization_id===ticket.organization_id&&row.registration_contact_id===contactId&&row.user_id&&validUsers.has(row.user_id)&&!importers.has(row.user_id)).map(row=>row.user_id));
    if(accounts.size>1){ambiguousCount+=1;continue;}
    const expected=accounts.size===1?[...accounts][0]:null;
    importedRecords.push({ticket,order,item,holder,contactId,evidence:[...evidence],importers:[...importers],accounts:[...accounts],expected});
    if(ticket.owner_user_id!==expected){
      incorrectCount+=1;if(expected===null)incorrectToNull+=1;else incorrectToAccount+=1;
      incorrectRecords.push({ticket,order,item,holder,contactId,evidence:[...evidence],importers:[...importers],accounts:[...accounts],expected});
    }
    if(ticket.owner_user_id&&importers.has(ticket.owner_user_id))ownerIsImporter+=1;
  }
  assert.equal(ambiguousCount,0,`140 deixou ${ambiguousCount} vínculo(s) ambíguo(s)`);

  const organizationGuard=await supabase.rpc('confirm_order_item_and_issue_ticket',{p_order_item_id:null});
  assert.match(organizationGuard.error?.message??'',/Item do pedido obrigatorio/i,'141: função canônica/guarda esperada ausente');
  console.log(JSON.stringify({regularizationAuditCount:regularization.count,importedCount,incorrectCount,incorrectToNull,incorrectToAccount,ambiguousCount,ownerIsImporter}));

  const incorrectIds=incorrectRecords.map(row=>row.ticket.id);
  const [audits,ownerChanges,events,contacts,holders,regularizationLogs]=await Promise.all([
    required('diagnostic audit logs',supabase.from('audit_logs').select('id,action,entity_id,event_id,details,created_at').in('entity_id',incorrectIds).order('created_at')),
    required('diagnostic owner history',supabase.from('ticket_owner_history').select('ticket_id,operation,previous_owner_user_id,new_owner_user_id,actor_user_id,reason_code,reason_text,created_at').in('ticket_id',incorrectIds).order('created_at')),
    required('diagnostic events',supabase.from('events').select('id,name').in('id',[...new Set(incorrectRecords.map(row=>row.ticket.event_id))])),
    required('diagnostic contacts',supabase.from('registration_contacts').select('id,full_name').in('id',[...new Set(incorrectRecords.map(row=>row.contactId).filter(Boolean))])),
    required('diagnostic holders',supabase.from('participants').select('id,full_name,user_id,registration_contact_id').in('id',[...new Set(incorrectRecords.map(row=>row.holder?.id).filter(Boolean))])),
    required('diagnostic regularization logs',supabase.from('audit_logs').select('id,entity_id,details,created_at').eq('action','imported_ticket_owner_regularized').order('created_at')),
  ]);
  const eventNames=new Map(events.map(row=>[row.id,row.name]));
  const contactNames=new Map(contacts.map(row=>[row.id,row.full_name]));
  const holderById=new Map(holders.map(row=>[row.id,row]));
  const appliedAt=regularizationLogs[0]?.created_at??null;
  const diagnostic=incorrectRecords.map(row=>{
    const ticketAudits=audits.filter(log=>log.entity_id===row.ticket.id);
    const ticketOwnerChanges=ownerChanges.filter(log=>log.ticket_id===row.ticket.id);
    const regularizationLog=regularizationLogs.find(log=>log.entity_id===row.ticket.id);
    const issuedAt=row.ticket.issued_at??row.order.created_at;
    const existedAt140=Boolean(appliedAt&&issuedAt&&new Date(issuedAt)<=new Date(appliedAt));
    const laterOwnerEvidence=[...ticketAudits.filter(log=>/owner/i.test(log.action)||log.details?.new_owner_user_id),...ticketOwnerChanges].filter(log=>!appliedAt||new Date(log.created_at)>new Date(appliedAt));
    return {
      ticket_id:row.ticket.id,issued_at:row.ticket.issued_at,order_created_at:row.order.created_at,event_id:row.ticket.event_id,event:eventNames.get(row.ticket.event_id),
      order_id:row.ticket.order_id,order_item_id:row.ticket.order_item_id,import_batch_ids:row.evidence,buyer_type:row.order.buyer_type,
      order_user_id:row.order.user_id,imported_by:row.importers,owner_user_id:row.ticket.owner_user_id,
      participant_id:row.holder?.id??null,holder:holderById.get(row.holder?.id)?.full_name??null,registration_contact_id:row.contactId,registration_contact:contactNames.get(row.contactId)??null,
      holder_accounts:row.accounts,correct_owner_user_id:row.expected,applied_140_at:appliedAt,existed_at_140:existedAt140,
      regularized_by_140:Boolean(regularizationLog),regularization_log:regularizationLog??null,owner_history:ticketOwnerChanges,
      later_owner_evidence:laterOwnerEvidence,audit_logs:ticketAudits,
      classification:!existedAt140?'CRIADO_APOS_140_COM_REGRA_ERRADA':regularizationLog&&laterOwnerEvidence.length?'REVERTIDO_APOS_140':'NAO_SELECIONADO_PELA_140',
    };
  });
  console.log('DIAGNOSTIC_140_COMPACT '+JSON.stringify(diagnostic.map(row=>({
    ticket_id:row.ticket_id,issued_at:row.issued_at,event:row.event,order_id:row.order_id,order_item_id:row.order_item_id,
    import_batch_ids:row.import_batch_ids,buyer_type:row.buyer_type,order_user_id:row.order_user_id,imported_by:row.imported_by,
    owner_user_id:row.owner_user_id,participant_id:row.participant_id,holder:row.holder,registration_contact_id:row.registration_contact_id,
    holder_accounts:row.holder_accounts,correct_owner_user_id:row.correct_owner_user_id,existed_at_140:row.existed_at_140,
    regularized_by_140:row.regularized_by_140,owner_history_count:row.owner_history.length,later_owner_evidence_count:row.later_owner_evidence.length,
    classification:row.classification,
  }))));
  console.log('DIAGNOSTIC_140_IMPORTED '+JSON.stringify(importedRecords.map(row=>({ticket_id:row.ticket.id,issued_at:row.ticket.issued_at,buyer_type:row.order.buyer_type,order_import_batch_id:row.order.import_batch_id,import_batch_ids:row.evidence,order_user_id:row.order.user_id,imported_by:row.importers,owner_user_id:row.ticket.owner_user_id,correct_owner_user_id:row.expected,registration_contact_id:row.contactId,holder_accounts:row.accounts,regularized_by_140:regularizationLogs.some(log=>log.entity_id===row.ticket.id)}))));
});
