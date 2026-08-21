import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const migrationUrl = new URL('../supabase/migrations/20260852000000_shirt_size_config_fixed_stock_and_lock_rules.sql', import.meta.url);
const itemChangeRulesUrl = new URL('../src/app/painel/eventos/[id]/item-change-rules.tsx', import.meta.url);
const painelEventPageUrl = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);
const eventosActionsUrl = new URL('../src/app/eventos/actions.ts', import.meta.url);
const operacoesActionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const minhaContaActionsUrl = new URL('../src/app/minha-conta/actions.ts', import.meta.url);
const editarActionsUrl = new URL('../src/app/inscricoes/[id]/editar/actions.ts', import.meta.url);
const editarPageUrl = new URL('../src/app/inscricoes/[id]/editar/page.tsx', import.meta.url);
const inscricoesActionsUrl = new URL('../src/app/inscricoes/actions.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// 1. Estoque por tamanho continua obrigatorio: event_kit_item_variant_inventory
// (1 linha por variante) e a estrutura fixa -- nunca teve checkbox pra
// ligar/desligar, e a nova RPC de troca passa a garantir a linha sempre.
test('1. controle de estoque por tamanho e regra fixa -- admin_change_ticket_shirt garante a linha de inventario da variante sempre, sem depender de nenhum checkbox', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_change_ticket_shirt');
  assert.match(fn, /insert into public\.event_kit_item_variant_inventory\(organization_id,event_id,kit_item_id,variant_id,total_quantity\)\s*\n\s*values\(v_ticket\.organization_id,v_ticket\.event_id,v_item\.id,v_variant\.id,0\)\s*\n\s*on conflict\(kit_item_id,variant_id\) do nothing;/);
});

// 2. "Controlar estoque por opcao" nao aparece mais pra camiseta na UI.
test('2. UI de configuracao nao mostra mais "Controlar estoque por opção" para itens do tipo shirt', async () => {
  const tsx = await readFile(itemChangeRulesUrl, 'utf8');
  assert.match(tsx, /item\.item_type === "shirt"/);
  const shirtBranch = tsx.match(/item\.item_type === "shirt" \? <div[\s\S]*?<\/div> : <div className="mt-2 flex flex-wrap gap-4">/)?.[0] ?? '';
  assert.notEqual(shirtBranch, '', 'ramo de UI para camiseta nao encontrado');
  assert.doesNotMatch(shirtBranch, /Controlar estoque por opção/);
  // As duas novas configuracoes, com os textos exatos pedidos.
  assert.match(shirtBranch, /Permitir alteração de tamanho pelo usuário/);
  assert.match(shirtBranch, /Permite que o participante altere o tamanho escolhido enquanto o ingresso ainda não teve kit entregue nem check-in\./);
  assert.match(shirtBranch, /Permitir escolha de tamanho somente se tiver estoque/);
  assert.match(shirtBranch, /Quando ativado, tamanhos sem estoque ficam indisponíveis para nova escolha ou alteração\./);
  // Itens de kit que NAO sao camiseta continuam com o checkbox antigo --
  // esta correcao e especificamente sobre camiseta.
  assert.match(tsx, /Controlar estoque por opção/);
});

test('painel de evento busca item_type e shirt_supply_mode pra poder distinguir camiseta dos demais itens de kit', async () => {
  const tsx = await readFile(painelEventPageUrl, 'utf8');
  assert.match(tsx, /select\("id,name,item_type,requires_variant,allow_participant_change,track_variant_inventory,shirt_supply_mode"\)/);
  assert.match(tsx, /require_stock_for_choice: item\.shirt_supply_mode === "stock"/);
});

// 3/4. Usuario pode/nao pode alterar tamanho conforme "Permitir alteração de
// tamanho pelo usuário" -- config A ja existente (allow_participant_change),
// nao duplicada.
test('3/4. config A (allow_participant_change) continua sendo o unico campo que controla alteracao pelo usuario -- nenhum campo duplicado foi criado', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_event_kit_item_change_rules');
  assert.match(fn, /allow_participant_change=coalesce\(p_allow_change,false\)/);
  assert.doesNotMatch(sql, /add column.*allow_participant_change/i);
  assert.doesNotMatch(sql, /add column.*shirt_supply_mode/i);
});

test('set_event_kit_item_change_rules ganha p_require_stock_for_choice, so com efeito em item_type=shirt; outros tipos mantem track_variant_inventory como antes', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /drop function if exists public\.set_event_kit_item_change_rules\(uuid, boolean, boolean\);/);
  const fn = extractFunction(sql, 'set_event_kit_item_change_rules');
  assert.match(fn, /p_require_stock_for_choice boolean default null/);
  assert.match(fn, /if v_item_type='shirt' then/);
  assert.match(fn, /shirt_supply_mode=case when coalesce\(p_require_stock_for_choice,true\) then 'stock' else 'made_to_order' end/);
  assert.match(fn, /else\s*\n\s*update public\.event_kit_items set allow_participant_change=coalesce\(p_allow_change,false\),track_variant_inventory=coalesce\(p_track_inventory,false\),updated_at=now\(\) where id=p_kit_item_id;/);
});

test('setEventKitItemChangeRulesAction (frontend) repassa p_require_stock_for_choice pra RPC', async () => {
  const ts = await readFile(eventosActionsUrl, 'utf8');
  assert.match(ts, /export async function setEventKitItemChangeRulesAction\(\s*\n\s*itemId: string,\s*\n\s*allowChange: boolean,\s*\n\s*trackInventory: boolean,\s*\n\s*requireStockForChoice\?: boolean,\s*\n\s*\)/);
  assert.match(ts, /p_require_stock_for_choice: requireStockForChoice \?\? null/);
});

// 5/6. Estoque 0 bloqueia/nao bloqueia ESCOLHA conforme config B
// (shirt_supply_mode='stock' vs 'made_to_order').
test('5. config B ligada (shirt_supply_mode=stock): admin_change_ticket_shirt bloqueia a ESCOLHA com SHIRT_OUT_OF_STOCK quando disponibilidade fisica < quantidade', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_change_ticket_shirt');
  assert.match(fn, /if v_item\.shirt_supply_mode='stock' then\s*\n\s*v_available:=greatest\(coalesce\(v_new_inv\.total_quantity,0\)-coalesce\(v_new_inv\.delivered_quantity,0\),0\);\s*\n\s*if v_available<v_qty then\s*\n\s*perform public\.raise_shirt_out_of_stock\(v_variant\.name,v_variant\.value,v_available\);/);
});

test('6. config B desligada (shirt_supply_mode=made_to_order): admin_change_ticket_shirt NUNCA chama raise_shirt_out_of_stock fora do bloco condicional a stock -- escolha sempre permitida', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_change_ticket_shirt');
  const stockGate = fn.match(/if v_item\.shirt_supply_mode='stock' then[\s\S]*?\n  end if;/)?.[0] ?? '';
  assert.notEqual(stockGate, '', 'bloco de checagem de estoque na escolha nao encontrado');
  const beforeGate = fn.slice(0, fn.indexOf(stockGate));
  const afterGate = fn.slice(fn.indexOf(stockGate) + stockGate.length);
  assert.doesNotMatch(beforeGate, /raise_shirt_out_of_stock/);
  assert.doesNotMatch(afterGate, /raise_shirt_out_of_stock/);
});

// 7. Estoque 0 SEMPRE bloqueia entrega fisica, independente da config B.
test('7. deliver_ticket_kit_item valida estoque fisico incondicionalmente para camiseta (fora de qualquer "if shirt_supply_mode=stock") -- nunca pulado em made_to_order', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_ticket_kit_item');
  const shirtBlock = fn.match(/if v_item\.item_type='shirt' then[\s\S]*?\n  end if;/)?.[0] ?? '';
  assert.notEqual(shirtBlock, '');
  assert.doesNotMatch(shirtBlock, /if v_item\.shirt_supply_mode='stock' then/);
  assert.match(shirtBlock, /perform public\.raise_shirt_out_of_stock\(v_variant\.name,v_variant\.value,v_available\);/);
  assert.match(shirtBlock, /v_available:=case when found then greatest\(v_inv\.total_quantity-v_inv\.delivered_quantity,0\) else 0 end;/);
});

test('7. deliver_ticket_full_kit valida estoque fisico pra camiseta nos dois modos (stock e made_to_order) antes de alterar qualquer item', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_ticket_full_kit');
  assert.match(fn, /and eki\.item_type='shirt' and eki\.shirt_supply_mode in\('stock','made_to_order'\)/);
  assert.doesNotMatch(fn, /and eki\.shirt_supply_mode='stock'\s*\n/);
});

// 8/9/10. kit entregue OU check-in realizado bloqueiam a troca no fluxo
// normal, para QUALQUER chamador (retirada/operacoes/importacao/
// autoatendimento), porque todos passam por admin_change_ticket_shirt.
test('8/9. admin_change_ticket_shirt trava a troca com SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION quando kit ja foi entregue OU check-in ja foi realizado', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_change_ticket_shirt');
  assert.match(
    fn,
    /if \(v_ticket\.status='used' or v_ticket\.used_at is not null\) or \(found and v_link\.status='delivered'\) then\s*\n\s*raise exception using errcode='P0001', message='SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION',/,
  );
});

test('10. admin_change_ticket_shirt e a RPC canonica usada por TODOS os fluxos normais (retirada/operacoes/importacao/autoatendimento) -- a trava vale pra admin tambem, sem excecao', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const changeShirtActionTs = await readFile(operacoesActionsUrl, 'utf8');
  const minhaContaTs = await readFile(minhaContaActionsUrl, 'utf8');
  const editarActionsTs = await readFile(editarActionsUrl, 'utf8');
  assert.match(sql, /create or replace function public\.admin_change_ticket_shirt/);
  // Os 3 chamadores diretos em src/ continuam usando a mesma RPC canonica --
  // nao existe um segundo caminho de escrita que escape da trava.
  assert.match(changeShirtActionTs, /supabase\.rpc\("admin_change_ticket_shirt"/);
  assert.match(minhaContaTs, /supabase\.rpc\('admin_change_ticket_shirt'/);
  assert.match(editarActionsTs, /supabase\.rpc\("admin_change_ticket_shirt"/);
});

test('frontend converte SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION em mensagem amigavel nos 4 pontos de entrada (operacoes, minha-conta, editar cadastro, resolucao de pendencias) -- nunca mostra o codigo cru', async () => {
  const operacoes = await readFile(operacoesActionsUrl, 'utf8');
  assert.match(operacoes, /serialized\.includes\("SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION"\)/);
  assert.match(operacoes, /O tamanho não pode mais ser alterado porque este ingresso já teve kit entregue ou check-in realizado\./);

  const minhaConta = await readFile(minhaContaActionsUrl, 'utf8');
  assert.match(minhaConta, /error\.message\.includes\('SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION'\)/);

  const editar = await readFile(editarActionsUrl, 'utf8');
  assert.match(editar, /function friendlyShirtRpcError/);
  assert.match(editar, /error\.message\.includes\("SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION"\)/);

  const inscricoes = await readFile(inscricoesActionsUrl, 'utf8');
  assert.match(inscricoes, /serialized\.includes\("SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION"\)/);
});

test('pagina de editar cadastro calcula shirtLocked = kit entregue OU check-in feito (nao so kit) e usa isso pra travar os selects normais', async () => {
  const actionsTs = await readFile(editarActionsUrl, 'utf8');
  assert.match(actionsTs, /shirtLocked: shirtDelivered \|\| shirtCheckinDone/);
  assert.match(actionsTs, /shirtCheckinDone = ticket\.status === "used"/);
  const pageTs = await readFile(editarPageUrl, 'utf8');
  assert.match(pageTs, /disabled=\{shirtLocked\}/);
  assert.match(pageTs, /disabled=\{shirtLocked\|\|!shirtType\}/);
  assert.doesNotMatch(pageTs, /shirtDelivered/);
});

// 11. Correcao administrativa (admin_correct_ticket_shirt_after_operation)
// mantem historico (audit_logs com ator/motivo/timestamp) e estoque
// coerente (fisico quando ja entregue, reserva quando so check-in).
test('11. admin_correct_ticket_shirt_after_operation e o UNICO caminho pra trocar tamanho apos kit/check-in, exige motivo, e so aceita quando ja esta travado', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_correct_ticket_shirt_after_operation');
  assert.match(fn, /perform public\.validate_operation_reason_code\(p_reason_code, p_reason_text\);/);
  assert.match(
    fn,
    /if not \(\(v_ticket\.status='used' or v_ticket\.used_at is not null\) or \(found and v_link\.status='delivered'\)\) then\s*\n\s*raise exception 'Este ingresso ainda nao teve kit entregue nem check-in; use a troca normal de tamanho\.';/,
  );
});

test('11. admin_correct_ticket_shirt_after_operation grava ator, timestamp implicito (created_at do audit_logs) e motivo no historico', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_correct_ticket_shirt_after_operation');
  assert.match(fn, /insert into public\.audit_logs\(action,entity_type,entity_id,event_id,details\) values\('ticket_shirt_admin_corrected_after_operation'/);
  assert.match(fn, /'actor_user_id',v_actor,'actor_email',v_actor_email/);
  assert.match(fn, /'reason_code',p_reason_code,'reason_text',nullif\(trim\(coalesce\(p_reason_text,''\)\),''\)/);
});

test('11. admin_correct_ticket_shirt_after_operation ajusta estoque coerentemente: devolve delivered_quantity do tamanho antigo e consome do novo quando kit ja foi entregue (impacto fisico real)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_correct_ticket_shirt_after_operation');
  assert.match(fn, /if v_was_delivered then/);
  assert.match(fn, /update public\.event_kit_item_variant_inventory set delivered_quantity=greatest\(delivered_quantity-v_qty,0\),updated_at=now\(\) where id=v_old_inv\.id;/);
  assert.match(fn, /update public\.event_kit_item_variant_inventory set delivered_quantity=delivered_quantity\+v_qty,updated_at=now\(\) where id=v_new_inv\.id;/);
  // Mesmo bloqueio de estoque zero que a entrega normal usa.
  assert.match(fn, /perform public\.raise_shirt_out_of_stock\(v_variant\.name,v_variant\.value,v_available\);/);
});

test('11. admin_correct_ticket_shirt_after_operation so ajusta reserved_quantity (nao delivered_quantity) quando o impacto e so de reserva (check-in feito, kit ainda pendente)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_correct_ticket_shirt_after_operation');
  const notDeliveredBranch = fn.match(/else\s*\n\s*-- Sem entrega fisica ainda[\s\S]*?\n\s*end if;\s*\n\s*end if;/)?.[0] ?? '';
  assert.notEqual(notDeliveredBranch, '');
  assert.match(notDeliveredBranch, /reserved_quantity=greatest\(reserved_quantity-v_qty,0\)/);
  assert.match(notDeliveredBranch, /reserved_quantity=reserved_quantity\+v_qty/);
  const executableLines = notDeliveredBranch.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(executableLines, /set delivered_quantity/);
});

test('correctShirtAfterOperationAction e correctParticipantShirtAfterOperationAction expostas no frontend chamam a RPC de correcao com motivo obrigatorio', async () => {
  const operacoes = await readFile(operacoesActionsUrl, 'utf8');
  assert.match(operacoes, /export async function correctShirtAfterOperationAction/);
  assert.match(operacoes, /supabase\.rpc\("admin_correct_ticket_shirt_after_operation"/);

  const editarActions = await readFile(editarActionsUrl, 'utf8');
  assert.match(editarActions, /export async function correctParticipantShirtAfterOperationAction/);
  assert.match(editarActions, /if \(!input\.reasonCode\.trim\(\)\) throw new Error\("Motivo obrigatório\."\);/);
  assert.match(editarActions, /supabase\.rpc\("admin_correct_ticket_shirt_after_operation"/);

  const editarPage = await readFile(editarPageUrl, 'utf8');
  assert.match(editarPage, /Corrigir tamanho após operação/);
  assert.match(editarPage, /REASON_CODES\.map/);
});

// Estoque continua sempre separado por tamanho -- undo/cancel simetricos a
// entrega, sem sobra fantasma de reserved/delivered_quantity em made_to_order.
test('undo_ticket_kit_item reverte estoque tambem em made_to_order (simetrico a entrega ter passado a decrementar nos dois modos)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'undo_ticket_kit_item');
  assert.match(fn, /if v_kit\.item_type='shirt' and v_kit\.shirt_supply_mode in\('stock','made_to_order'\) then/);
});

test('admin_cancel_ticket libera reserved_quantity tambem em made_to_order, e nunca bloqueia o cancelamento quando a linha de estoque nao existe (dado legado)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_cancel_ticket');
  assert.match(fn, /v_link\.item_type='shirt' and v_link\.shirt_supply_mode in\('stock','made_to_order'\)/);
  assert.match(fn, /if found then\s*\n\s*update public\.event_kit_item_variant_inventory set reserved_quantity=greatest\(reserved_quantity-v_link\.quantity,0\),updated_at=now\(\) where id=v_inventory\.id;\s*\n\s*end if;/);
  assert.doesNotMatch(fn, /raise exception 'Reserva inconsistente/);
});

test('nenhuma regra de titularidade, propriedade, pulseira, check-in, entrega, arquitetura de pedidos, loja ou produtos extras foi alterada por esta migration', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /wristband_required_for_checkin\s*=|drop.*wristband|ticket_owner_history|registration_contact_id\s*=\s*new/i);
  assert.doesNotMatch(sql, /create table|alter table|drop table/i);
});
