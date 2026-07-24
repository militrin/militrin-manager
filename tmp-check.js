const { createClient } = require('@supabase/supabase-js');
const url='https://vjrkmtznstljaywjkjnk.supabase.co';
const key='sb_publishable_ZdxyQlNvuGxei2vx0OM6Bg_c8fQ8-EV';
const supabase=createClient(url,key);
(async()=>{
  const checks=[
    ['events',()=>supabase.from('events').select('id').limit(1).maybeSingle()],
    ['participants',()=>supabase.from('participants').select('id').limit(1).maybeSingle()],
    ['payments',()=>supabase.from('payments').select('id').limit(1).maybeSingle()],
    ['shirt_inventory',()=>supabase.from('shirt_inventory').select('id').limit(1).maybeSingle()],
    ['kit_deliveries',()=>supabase.from('kit_deliveries').select('id').limit(1).maybeSingle()],
    ['audit_logs',()=>supabase.from('audit_logs').select('id').limit(1).maybeSingle()],
  ];
  for(const [label,fn] of checks){
    try{ const result=await fn(); console.log(label, result.error ? 'ERR '+result.error.message : 'OK'); }
    catch(e){ console.log(label, 'ERR '+e.message); }
  }
})();
