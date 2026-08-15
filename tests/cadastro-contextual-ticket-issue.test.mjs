import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('ficha simplifica cabecalho e oferece emissao contextual primaria',async()=>{
  const [page,topbar]=await Promise.all([read('../src/app/cadastros/[id]/page.tsx'),read('../src/components/dashboard/TopBar.tsx')]);
  assert.match(page,/Emitir ingresso/);
  assert.match(page,/ingressos\/emitir\?from=cadastro&contactId=/);
  assert.match(page,/bg-emerald-500/);
  assert.doesNotMatch(topbar,/Buscar inscrição|Novo cadastro|showCadastroShortcuts/);
  assert.match(topbar,/actions\?: ReactNode/);
});

test('emissor existente preseleciona cadastro por UUID e preserva breadcrumb',async()=>{
  const [page,form]=await Promise.all([read('../src/app/ingressos/emitir/page.tsx'),read('../src/app/ingressos/emitir/issue-ticket-form.tsx')]);
  assert.match(page,/registration_contacts/);
  assert.match(page,/\.eq\("id", requestedContactId\)/);
  assert.match(page,/\.eq\("organization_id", org\.id\)/);
  assert.match(page,/label:contactContext\.name,href:cadastroHref/);
  assert.match(page,/label:"Emitir ingresso"/);
  assert.match(form,/Emitindo para:/);
  assert.match(form,/registrationContactId/);
});

test('action usa registration_contact_id exato e nao infere propriedade do cadastro',async()=>{
  const action=await read('../src/app/ingressos/emitir/actions.ts');
  assert.match(action,/registrationContactId\?: string \| null/);
  assert.match(action,/contactQuery\.eq\("id", input\.registrationContactId as string\)/);
  assert.match(action,/p_registration_contact_id: String\(contactResult\.data\.id\)/);
  assert.doesNotMatch(action,/owner_user_id/);
  assert.doesNotMatch(action,/full_name.*owner|email.*owner/i);
});

test('sucesso oferece retorno ao cadastro e ingresso no mesmo contexto',async()=>{
  const form=await read('../src/app/ingressos/emitir/issue-ticket-form.tsx');
  assert.match(form,/Voltar para \{contactLookup\.name\}/);
  assert.match(form,/\/cadastros\/\$\{registrationContactId\}/);
  assert.match(form,/\/ingressos\/\$\{ticketId\}\?from=cadastro&contactId=/);
});

test('TopBar global nao injeta busca ou cadastro e listas mantem acoes locais',async()=>{
  const [topbar,cadastros,ingressos]=await Promise.all([read('../src/components/dashboard/TopBar.tsx'),read('../src/app/cadastros/page.tsx'),read('../src/app/ingressos/page.tsx')]);
  assert.doesNotMatch(topbar,/placeholder="Buscar|Novo cadastro|href="\/cadastros\/novo"/);
  assert.match(topbar,/\{actions\}/);
  assert.match(cadastros,/placeholder="Nome, CPF, e-mail ou telefone"/);
  assert.match(cadastros,/href="\/cadastros\/novo"[\s\S]*Novo cadastro/);
  assert.match(ingressos,/href="\/ingressos\/emitir"[\s\S]*Emitir ingresso/);
});
