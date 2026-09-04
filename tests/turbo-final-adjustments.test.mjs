import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

// Normaliza CRLF->LF (ver mesmo comentario em turbo-qr-camera-fallback.test.mjs).
async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const turboRouteClient = await readFile(new URL("../src/app/operacoes/turbo/TurboRouteClient.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("../src/components/dashboard/Sidebar.tsx", import.meta.url), "utf8");
const adminMenu = await readFile(new URL("../src/lib/navigation/admin-menu.ts", import.meta.url), "utf8");
const turboMode = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8");
const errorMessages = await readFile(new URL("../src/app/operacoes/error-messages.ts", import.meta.url), "utf8");
const migration860 = await readFile(new URL("../supabase/migrations/20260860000000_turbo_mode_wristband_and_store_item_qr.sql", import.meta.url), "utf8");
const migration861 = await readFile(new URL("../supabase/migrations/20260861000000_wristband_conflict_holder_detail.sql", import.meta.url), "utf8");
const wristbandClient = await readFile(new URL("../src/app/operacoes/pulseira/WristbandLookupClient.tsx", import.meta.url), "utf8");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `marcador de fim nao encontrado: ${endMarker}`);
  return source.slice(start, end);
}

// ============================================================
// 1. Contexto de evento do Turbo -- escolhido a cada entrada nova
// ============================================================

test("evento nunca e auto-selecionado a partir de query param -- so sessionStorage de uma operacao ja em andamento (F5)", () => {
  assert.doesNotMatch(turboRouteClient, /useSearchParams/);
  assert.doesNotMatch(turboRouteClient, /searchParams\.get\("eventId"\)/);
  assert.match(turboRouteClient, /window\.sessionStorage\.getItem\(TURBO_EVENT_SESSION_KEY\)/);
});

test("usa sessionStorage, nunca localStorage, pra guardar o evento escolhido", () => {
  const executableCode = turboRouteClient
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(executableCode, /localStorage/);
  assert.match(turboRouteClient, /window\.sessionStorage\.(get|set|remove)Item/);
});

test("evento salvo e SEMPRE revalidado contra a lista atual de eventos (nunca confia cegamente no valor salvo)", () => {
  const fn = slice(turboRouteClient, "void getTurboEventsAction().then", "});\n    return () => {\n      mounted = false;");
  assert.match(fn, /response\.events\.find\(\(event\) => event\.id === storedEventId\)/);
  assert.match(fn, /if \(revalidated\) setSelectedEvent\(revalidated\);/);
  assert.match(fn, /else window\.sessionStorage\.removeItem\(TURBO_EVENT_SESSION_KEY\)/);
});

test("selecionar um evento grava a chave -- proximas leituras dentro da mesma operacao nao pedem de novo (estado React + sessionStorage, nao um novo fetch por leitura)", () => {
  const fn = slice(turboRouteClient, "function chooseEvent", "function handleExit");
  assert.match(fn, /window\.sessionStorage\.setItem\(TURBO_EVENT_SESSION_KEY, event\.id\)/);
  assert.match(fn, /setSelectedEvent\(event\)/);
});

test("Sair do Modo Turbo limpa a chave explicitamente ANTES de navegar -- contexto descartado", () => {
  const fn = slice(turboRouteClient, "function handleExit", "if (selectedEvent) {");
  const clearIndex = fn.indexOf("window.sessionStorage.removeItem(TURBO_EVENT_SESSION_KEY)");
  const pushIndex = fn.indexOf("router.push(");
  assert.ok(clearIndex !== -1 && pushIndex !== -1 && clearIndex < pushIndex, "precisa limpar a chave ANTES de navegar pra fora");
});

test("desmontar a rota (back-button, ou qualquer saida que nao seja o botao Sair) tambem limpa o contexto -- nunca fica orfao", () => {
  const cleanupEffect = slice(turboRouteClient, "useEffect(() => {\n    // Descarta o contexto", "}, []);");
  assert.match(cleanupEffect, /return \(\) => {\s*window\.sessionStorage\.removeItem\(TURBO_EVENT_SESSION_KEY\);/);
});

test("Sidebar NUNCA propaga ?eventId= pro link do Modo Turbo -- a rota sempre decide sozinha (sessionStorage), nunca herda contexto de outra pagina", () => {
  assert.match(sidebar, /function eventScopedHref\(href: string, selectedEventId: string \| null\)/);
  assert.match(sidebar, /EVENT_SCOPED_HREFS\.includes\(href\)/);
  const scopedList = slice(adminMenu, "export const EVENT_SCOPED_HREFS = [", "];");
  assert.doesNotMatch(scopedList, /"\/operacoes\/turbo"/);
  assert.match(scopedList, /"\/operacoes\/pulseira"/);
});

test("getTurboEventsAction (usada pro seletor) nao depende de nenhum estado de evento previamente selecionado -- sempre lista tudo que o operador pode escolher de novo", () => {
  const fn = slice(actions, "export async function getTurboEventsAction", "export async function getKitMaterializationPreviewAction");
  assert.doesNotMatch(fn, /eventId/i);
});

// ============================================================
// 2. Pulseira ja vinculada no Turbo -- avisos explicitos
// ============================================================

test("RPC SEMPRE chama link_wristband_to_ticket quando ha codigo -- nunca pula essa validacao so porque o ingresso ja tem alguma pulseira ativa (causa raiz do silencio)", () => {
  const rpc = slice(migration860, "create or replace function public.deliver_items_checkin_and_link_wristband", "revoke all on function public.deliver_items_checkin_and_link_wristband");
  assert.doesNotMatch(rpc, /if not v_has_wristband then/);
  assert.match(rpc, /v_link_result := public\.link_wristband_to_ticket\(v_ticket\.id, v_code\)/);
  assert.match(rpc, /v_already_linked := coalesce\(\(v_link_result ->> 'already_linked'\)::boolean, false\)/);
});

test("pulseira ja vinculada ao MESMO ingresso e ja concluido levanta erro codificado especifico ANTES de tentar entrega/checkin de novo (nenhuma operacao duplicada)", () => {
  const rpc = slice(migration860, "create or replace function public.deliver_items_checkin_and_link_wristband", "revoke all on function public.deliver_items_checkin_and_link_wristband");
  const raiseIndex = rpc.indexOf("WRISTBAND_ALREADY_LINKED_SAME_TICKET");
  const deliverIndex = rpc.indexOf("perform public.deliver_ticket_full_kit");
  assert.ok(raiseIndex !== -1 && deliverIndex !== -1 && raiseIndex < deliverIndex, "o erro precisa ser levantado ANTES de deliver_ticket_full_kit/checkin_ticket_entry");
  assert.match(rpc, /if v_already_linked and v_ticket\.status = 'used' then/);
  assert.match(rpc, /'Esta pulseira já está vinculada a este ingresso\.'/);
});

test("pulseira de OUTRO ingresso continua bloqueada por link_wristband_to_ticket (nao sobrescreve vinculo automaticamente) -- agora com detail estruturado incluindo o titular do outro ingresso quando resolvivel", () => {
  assert.match(migration861, /if v_existing\.ticket_id = p_ticket_id then/);
  assert.match(migration861, /raise exception 'Ingresso nao encontrado\.'; end if;/); // sanity: mesmo corpo original preservado
  assert.match(migration861, /'WRISTBAND_LINKED_TO_ANOTHER_TICKET'/);
  assert.match(migration861, /v_other_holder_name/);
  // Mensagem TOPO nunca muda -- compatibilidade com linkWristbandAction/replaceWristbandAction, que so leem error.message.
  assert.match(migration861, /message = 'Pulseira ja vinculada a outro ingresso\.',/);
});

test("link_wristband_to_ticket muda de assinatura? NAO -- create or replace direto, sem drop/regrant extra, pra nao quebrar chamadores existentes", () => {
  assert.match(migration861, /create or replace function public\.link_wristband_to_ticket\(p_ticket_id uuid, p_code text\) returns jsonb/);
  assert.doesNotMatch(migration861, /drop function/i);
});

test("operationRpcError nunca engole os 2 codigos novos -- sempre retorna code+message explicitos, com fallback se o JSON.parse falhar", () => {
  const fn = slice(actions, "function operationRpcError");
  assert.match(fn, /WRISTBAND_ALREADY_LINKED_SAME_TICKET/);
  assert.match(fn, /WRISTBAND_LINKED_TO_ANOTHER_TICKET/);
  assert.match(fn, /holder_name/);
});

test("titulos amigaveis dedicados pros 2 novos codigos (nao caem no titulo generico)", () => {
  assert.match(errorMessages, /code === "WRISTBAND_ALREADY_LINKED_SAME_TICKET"/);
  assert.match(errorMessages, /code === "WRISTBAND_LINKED_TO_ANOTHER_TICKET"/);
});

test("TurboMode nunca engole o erro -- handleWristbandScan sempre despacha FAIL com o titulo/mensagem reais (nunca cai num catch mudo), e mostra o titular do outro ingresso quando disponivel", () => {
  const fn = slice(turboMode, "async function handleWristbandScan", "async function handleProductConfirm");
  assert.match(fn, /if \(!response\.success\)/);
  assert.match(fn, /const holderName = 'holder_name' in response \? response\.holder_name : null/);
  assert.match(fn, /Titular: \$\{holderName\}/);
  assert.match(fn, /dispatch\(\{\s*type: 'FAIL',/);
});

test("erro de pulseira oferece 'Tentar outra pulseira' (volta pra scanning_wristband do MESMO ingresso) alem de cancelar -- operador nunca fica preso", () => {
  assert.match(turboMode, /type: 'RETRY_WRISTBAND'; participant: OperationTicketDetails/);
  assert.match(turboMode, /case 'RETRY_WRISTBAND':\s*\n\s*return \{ kind: 'scanning_wristband', participant: action\.participant \};/);
  assert.match(turboMode, /Tentar outra pulseira/);
  assert.match(turboMode, /Cancelar e voltar ao leitor inicial/);
});

// ============================================================
// 3. Ver pulseira vinculada -- diferenciar vinculada/sem vinculo/invalida
// ============================================================

test("lookupWristbandByQrAction distingue 3 estados: QR invalido (success:false), sem vinculo (state:'unlinked'), vinculada (state:'linked')", () => {
  const fn = slice(actions, "export async function lookupWristbandByQrAction");
  assert.match(fn, /QR Code não corresponde a nenhuma pulseira conhecida\./);
  assert.match(fn, /if \(wristband\.status !== "active"\) \{\s*\n\s*return \{ success: true as const, state: "unlinked" as const, wristband: wristbandSummary \};/);
  assert.match(fn, /state: "linked" as const/);
});

test("pulseira sem vinculo NUNCA inventa comprador/titular -- so retorna o wristband, sem buscar ticket", () => {
  const unlinkedBranch = slice(actions, 'if (wristband.status !== "active") {', "const { data: ticket } = await supabase");
  assert.doesNotMatch(unlinkedBranch, /get_operation_buyers|holder_full_name|buyer_name/);
});

test("cross-organization continua bloqueado -- RLS de participant_wristbands filtra antes da query chegar no app, tratado igual a nao encontrado (nunca vaza 'existe em outra organizacao')", () => {
  const fn = slice(actions, "export async function lookupWristbandByQrAction", "const wristbandSummary = {");
  assert.match(fn, /RLS/);
  assert.match(fn, /vaza/);
});

test("UI de Ver pulseira vinculada mostra os 3 estados com textos distintos", () => {
  assert.match(wristbandClient, /QR não reconhecido/);
  assert.match(wristbandClient, /Pulseira ainda não vinculada\./);
  assert.match(wristbandClient, /Pulseira desvinculada e disponível para novo vínculo\./);
  assert.match(wristbandClient, /Pulseira vinculada/);
  assert.doesNotMatch(wristbandClient, /Esta pulseira ainda não pertence a nenhum participante\./);
});

test("estado 'linked' continua mostrando comprador/titular/evento/categoria/status; estado 'unlinked' so mostra o codigo, nunca dados de ingresso antigos", () => {
  const unlinkedBranch = slice(wristbandClient, 'result.state === "unlinked" ? (', 'result.state === "linked" ? (');
  const linkedBranch = slice(wristbandClient, 'result.state === "linked" ? (', 'className="mt-6 flex flex-wrap gap-3"');
  assert.match(linkedBranch, /Comprador/);
  assert.match(linkedBranch, /Titular do ingresso/);
  assert.doesNotMatch(unlinkedBranch, /Comprador|Titular do ingresso|buyer_name|holder_name/);
});
