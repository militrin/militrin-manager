import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarizeIntegrityReport } from '../src/lib/integrity/report.ts';

const dashboard = await readFile(new URL('../src/app/painel/page.tsx', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/app/painel/integridade/page.tsx', import.meta.url), 'utf8');
const center = await readFile(new URL('../src/app/painel/integridade/integrity-center.tsx', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/painel/integridade/actions.ts', import.meta.url), 'utf8');

const issue = (severity, code='CHECK') => ({ code, severity, domain:'test', title:'Teste', description:'Teste', eventId:'event', affectedCount:1, actionLabel:null, actionHref:null, sampleEntityType:'ticket', sampleEntityId:'id' });

test('um bloqueio da fonte canonica produz 1 no resumo compartilhado',()=>{
  assert.deepEqual(summarizeIntegrityReport([issue('critical')],14),{critical:1,attention:0,warning:0,ok:13});
  assert.deepEqual(summarizeIntegrityReport([],14),{critical:0,attention:0,warning:0,ok:14});
});

test('Dashboard e detalhe usam a mesma action, RPC e sumarizador',()=>{
  assert.match(dashboard,/getIntegrityReportAction/); assert.match(dashboard,/summarizeIntegrityReport/);
  assert.match(page,/getIntegrityReportAction\(eventId\)/); assert.match(center,/summarizeIntegrityReport\(issues, totalDetectorCount\)/);
  assert.match(actions,/rpc\('get_operational_integrity_report'/);
});

test('eventId do Dashboard chega ao detalhe e permanece no refresh',()=>{
  assert.match(dashboard,/`\/painel\/integridade\?eventId=\$\{encodeURIComponent\(selectedId\)\}`/);
  assert.match(page,/searchParams: Promise<\{ eventId\?: string \}>/); assert.match(page,/initialSelectedEventId=\{eventId\}/);
  assert.match(center,/useState<string \| null>\(initialSelectedEventId\)/); assert.match(center,/router\.replace\(next \? `\/painel\/integridade\?eventId=/);
});

test('status critical attention warning nao sao remapeados ou descartados',()=>{
  const totals=summarizeIntegrityReport([issue('critical','A'),issue('attention','B'),issue('warning','C')],14);
  assert.deepEqual(totals,{critical:1,attention:1,warning:1,ok:11});
  assert.doesNotMatch(center,/\.filter\([^\n]*(resolved|acknowledged|details)/i);
});

test('detalhe mostra bloco explicito inclusive no estado zero',()=>{
  assert.match(center,/Bloqueios \(\{totals\.critical\}\)/);
  assert.match(center,/Nenhum bloqueio encontrado\./);
  assert.match(center,/group\.cards\.map/);
});
