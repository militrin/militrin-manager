import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendNavigationContext, isSafeContextUuid, safeInternalHref } from '../src/lib/navigation/admin-navigation.ts';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');
const uuid='91b9bc32-1234-4abc-8def-1234567890ab';

test('returnTo aceita somente navegacao interna segura',()=>{
  assert.equal(safeInternalHref('/cadastros?pagina=2','/painel'),'/cadastros?pagina=2');
  for(const unsafe of ['https://evil.example','//evil.example','javascript:alert(1)','/\\evil.example','']) assert.equal(safeInternalHref(unsafe,'/painel'),'/painel');
});

test('contexto de cadastro e estruturado e exige UUID',()=>{
  assert.equal(isSafeContextUuid(uuid),true);
  assert.equal(isSafeContextUuid('Douglas Hobold'),false);
  assert.equal(appendNavigationContext('/ingressos/ticket',{from:'cadastro',contactId:uuid}),`/ingressos/ticket?from=cadastro&contactId=${uuid}`);
  assert.equal(appendNavigationContext('/ingressos/ticket',{from:'cadastro',contactId:'https://evil.example'}),'/ingressos/ticket');
});

test('breadcrumb e compacto, responsivo, links anteriores e pagina atual sem link',async()=>{
  const component=await read('../src/components/navigation/AppBreadcrumb.tsx');
  assert.match(component,/aria-label="Breadcrumb"/);
  assert.match(component,/overflow-x-auto/);
  assert.match(component,/truncate/);
  assert.match(component,/current \|\| !item\.href/);
  assert.match(component,/aria-current=\{current \? "page"/);
  assert.match(component,/<Link href=\{safeInternalHref\(item\.href/);
  assert.match(component,/Voltar ao contexto anterior/);
});

test('cadastro ingresso e edicao preservam origem; entrada direta usa ingressos',async()=>{
  const [cadastro,ticket,edit]=await Promise.all([
    read('../src/app/cadastros/[id]/page.tsx'),
    read('../src/app/ingressos/[ticketId]/page.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/page.tsx'),
  ]);
  assert.match(cadastro,/from=cadastro&contactId=\$\{id\}/);
  assert.match(ticket,/requestedContactId === contactId/);
  assert.match(ticket,/adminEditHref=\{editHref\}/);
  assert.match(ticket,/\{label:"Ingressos",href:"\/ingressos"\}/);
  assert.match(edit,/requestedContactId === item\?\.registration_contact_id/);
  assert.match(edit,/\{label:"Editar ingresso"\}/);
  assert.match(edit,/fallbackHref="\/ingressos"/);
});

test('labels dinamicos usam nomes e identificadores legiveis',async()=>{
  const [cadastro,event,ticket]=await Promise.all([
    read('../src/app/cadastros/[id]/page.tsx'),
    read('../src/app/painel/eventos/[id]/page.tsx'),
    read('../src/app/ingressos/[ticketId]/page.tsx'),
  ]);
  assert.match(cadastro,/label:String\(contact\.full_name\)/);
  assert.match(event,/label:String\(event\.name\)/);
  assert.match(ticket,/const ticketLabel = `#\$\{String\(data\.token/);
  assert.match(ticket,/category\?\.name/);
});

test('TopBar aplica breadcrumb global as paginas administrativas',async()=>{
  const topbar=await read('../src/components/dashboard/TopBar.tsx');
  assert.match(topbar,/AppBreadcrumb/);
  assert.match(topbar,/breadcrumbs \?\? \[\{label:"Início",href:"\/painel"\},\{label:title\}\]/);
});

test('paginas profundas auditadas possuem breadcrumb e retorno pai seguro',async()=>{
  const [newContact,courtesies,editParticipant,newEvent]=await Promise.all([
    read('../src/app/cadastros/novo/page.tsx'),
    read('../src/app/ingressos/cortesias/page.tsx'),
    read('../src/app/inscricoes/[id]/editar/page.tsx'),
    read('../src/app/painel/eventos/novo/page.tsx'),
  ]);
  assert.match(newContact,/\{label:"Cadastros",href:"\/cadastros"\}/);
  assert.match(newContact,/backHref="\/cadastros"/);
  assert.match(courtesies,/\{label:"Ingressos",href:"\/ingressos"\}/);
  assert.match(courtesies,/backHref="\/ingressos"/);
  assert.match(editParticipant,/\{label:participant\.full_name,href:participantHref\}/);
  assert.match(editParticipant,/backHref=\{participantHref\}/);
  assert.match(newEvent,/\{label:"Eventos",href:"\/painel\/eventos"\}/);
  assert.match(newEvent,/backHref="\/painel\/eventos"/);
});
