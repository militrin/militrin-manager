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
  assert.match(page,/query\.eventId && uuid\.test\(query\.eventId\)/);
  assert.match(form,/Emitindo para:/);
  assert.match(form,/registrationContactId/);
  assert.match(form,/initialEventId/);
});

test('action usa registration_contact_id exato e nao infere propriedade por e-mail/identidade',async()=>{
  const action=await read('../src/app/ingressos/emitir/actions.ts');
  assert.match(action,/registrationContactId\?: string \| null/);
  assert.match(action,/contactQuery\.eq\("id", input\.registrationContactId as string\)/);
  assert.match(action,/p_registration_contact_id: String\(contactResult\.data\.id\)/);
  // A leitura de owner_user_id e pos-emissao: confere destino do fluxo
  // autorizado (Cadastro.user_id / intended_owner_contact_id). Nao atribui
  // ownership por coincidencia de e-mail, nome ou participant.
  assert.match(action,/\.select\("id, owner_user_id, intended_owner_contact_id, participant_id"\)/);
  assert.match(action,/destinationUserId && owner !== destinationUserId/);
  assert.doesNotMatch(action,/\.from\("tickets"\)[\s\S]*\.update\(/);
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

test('round-trip Novo cadastro preserva eventId valido e PIN; invalido nao propaga',async()=>{
  const [form,novoPage,novoAction,emitir]=await Promise.all([
    read('../src/app/ingressos/emitir/issue-ticket-form.tsx'),
    read('../src/app/cadastros/novo/page.tsx'),
    read('../src/app/cadastros/novo/actions.ts'),
    read('../src/app/ingressos/emitir/page.tsx'),
  ]);
  assert.match(form,/uuid\.test\(eventId\) \? `\/cadastros\/novo\?eventId=\$\{encodeURIComponent\(eventId\)\}` : "\/cadastros\/novo"/);
  assert.match(novoPage,/query\.eventId && uuid\.test\(query\.eventId\)/);
  assert.match(novoPage,/name="event_id"/);
  assert.match(novoPage,/\/ingressos\/emitir\?pin=\$\{encodeURIComponent\(query\.pin\)\}&eventId=\$\{encodeURIComponent\(eventId\)\}/);
  assert.match(novoPage,/\/ingressos\/emitir\?pin=\$\{encodeURIComponent\(query\.pin\)\}/);
  assert.match(novoAction,/formData\.get\("event_id"\)/);
  assert.match(novoAction,/uuid\.test\(eventId\)[\s\S]*search\.set\("eventId", eventId\)/);
  assert.doesNotMatch(novoAction,/from\("events"\)/);
  assert.match(emitir,/query\.eventId && uuid\.test\(query\.eventId\)/);
  assert.match(emitir,/\.eq\("organization_id", org\.id\)[\s\S]*\.eq\("is_active", true\)[\s\S]*\.is\("archived_at", null\)/);
  assert.match(emitir,/eventOptions\.some\(\(event\) => event\.id === requestedEventId\) \? requestedEventId : ""/);
  assert.match(emitir,/hasPermission\("participants.create"\)/);
});
