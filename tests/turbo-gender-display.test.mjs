import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";
import {
  resolveTurboOperationalGender,
  turboGenderFromTicket,
  turboGenderLabel,
  turboOperationalGenderDisplay,
  turboOperationalGenderLabel,
} from "../src/lib/operations/turbo-gender-label.ts";

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const turbo = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8");
const issueActions = await readFile(new URL("../src/app/ingressos/emitir/actions.ts", import.meta.url), "utf8");
const issueForm = await readFile(new URL("../src/app/ingressos/emitir/issue-ticket-form.tsx", import.meta.url), "utf8");
const helper = await readFile(new URL("../src/lib/operations/turbo-gender-label.ts", import.meta.url), "utf8");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

test("male/female viram Masculino/Feminino; ausente e tecnico nao vazam na UI", () => {
  assert.equal(turboGenderLabel("male"), "Masculino");
  assert.equal(turboGenderLabel("female"), "Feminino");
  assert.equal(turboGenderLabel("MALE"), "Masculino");
  assert.equal(turboGenderLabel("Masculino"), "Masculino");
  assert.equal(turboGenderLabel("Feminino"), "Feminino");
  assert.equal(turboGenderLabel("other"), "Outro");
  assert.equal(turboGenderLabel("prefer_not_to_say"), "Prefiro não informar");
  assert.equal(turboGenderLabel(null), "Não informado");
  assert.equal(turboGenderLabel(""), "Não informado");
  assert.equal(turboGenderLabel("null"), "Não informado");
  assert.equal(turboGenderLabel("unknown_code"), "Não informado");
  assert.doesNotMatch(turboGenderLabel("male"), /male/);
  assert.doesNotMatch(turboGenderLabel("female"), /female/);
});

test("1. pricing male + cadastro female -> Masculino (pricing vence)", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: "male",
    participant_gender: "female",
    contact_gender: "female",
    import_batch_id: null,
    order_buyer_type: "administrative",
  });
  assert.deepEqual(resolved, { value: "male", source: "pricing" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Masculino");
  assert.equal(turboGenderFromTicket({ pricing_gender: "male", gender: "female" }), "Masculino");
  assert.equal(turboGenderFromTicket({ pricing_gender: "male", gender: "Feminino" }), "Masculino");
});

test("2. pricing female + cadastro male -> Feminino (pricing vence)", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: "female",
    participant_gender: "male",
    contact_gender: "male",
    import_batch_id: "batch-legado",
    order_buyer_type: "imported_holder",
  });
  assert.deepEqual(resolved, { value: "female", source: "pricing" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Feminino");
  assert.equal(turboGenderFromTicket({ pricing_gender: "female", gender: "male" }), "Feminino");
  assert.equal(turboGenderFromTicket({ pricing_gender: "female", gender: "Masculino" }), "Feminino");
});

test("3. importado pricing null + cadastro male -> Masculino (legacy_profile)", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: null,
    participant_gender: "male",
    contact_gender: "male",
    import_batch_id: "batch-legado",
    order_buyer_type: "imported_holder",
  });
  assert.deepEqual(resolved, { value: "male", source: "legacy_profile" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Masculino");
  assert.equal(turboGenderFromTicket({
    pricing_gender: null,
    gender: "male",
    import_batch_id: "batch-legado",
  }), "Masculino");
});

test("4. importado pricing null + cadastro female -> Feminino (legacy_profile)", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: null,
    participant_gender: null,
    contact_gender: "female",
    order_buyer_type: "imported_holder",
  });
  assert.deepEqual(resolved, { value: "female", source: "legacy_profile" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Feminino");
  assert.equal(turboGenderFromTicket({
    pricing_gender: null,
    gender: "female",
    order_buyer_type: "imported_holder",
  }), "Feminino");
});

test("5. importado pricing null + participant/contact divergentes -> Nao definido", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: null,
    participant_gender: "male",
    contact_gender: "female",
    import_batch_id: "batch-legado",
  });
  assert.deepEqual(resolved, { value: null, source: "unknown" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Não definido");
});

test("6. importado sem qualquer genero -> Nao definido", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: null,
    participant_gender: null,
    contact_gender: null,
    import_batch_id: "batch-legado",
    order_buyer_type: "imported_holder",
  });
  assert.deepEqual(resolved, { value: null, source: "unknown" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Não definido");
});

test("7. ingresso NOVO pricing null + cadastro male -> Nao definido", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: null,
    participant_gender: "male",
    contact_gender: "male",
    import_batch_id: null,
    order_buyer_type: "account",
  });
  assert.deepEqual(resolved, { value: null, source: "unknown" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Não definido");
  assert.equal(turboGenderFromTicket({
    pricing_gender: null,
    gender: "male",
    order_buyer_type: "account",
  }), "Não definido");
});

test("8. ingresso NOVO pricing null + cadastro female -> Nao definido", () => {
  const resolved = resolveTurboOperationalGender({
    pricing_gender: null,
    participant_gender: "female",
    contact_gender: "female",
    import_batch_id: null,
    order_buyer_type: "administrative",
  });
  assert.deepEqual(resolved, { value: null, source: "unknown" });
  assert.equal(turboOperationalGenderDisplay(resolved), "Não definido");
  assert.equal(turboGenderFromTicket({ gender: "female" }), "Não definido");
});

test("9. emissao manual Masculino persiste male e o Turbo mostra Masculino", () => {
  assert.match(issueForm, /useState\("male"\)/);
  assert.match(issueForm, /<option value="male">Masculino<\/option>/);
  assert.match(issueActions, /normalizePricingGenderInput\(input\.pricingGender\)/);
  assert.match(issueActions, /p_pricing_gender: pricingGender/);
  assert.equal(turboOperationalGenderLabel("male"), "Masculino");
  assert.equal(turboGenderFromTicket({ pricing_gender: "male" }), "Masculino");
});

test("10. emissao manual Feminino persiste female e o Turbo mostra Feminino", () => {
  assert.match(issueForm, /<option value="female">Feminino<\/option>/);
  assert.equal(turboOperationalGenderLabel("female"), "Feminino");
  assert.equal(turboGenderFromTicket({ pricing_gender: "female" }), "Feminino");
});

test("ficha QR identificado mostra Gênero operacional entre Camiseta e Kit, sem copy de fallback", () => {
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  const camiseta = review.indexOf('<Fact label="Camiseta"');
  const genero = review.indexOf('<Fact label="Gênero"');
  const kit = review.indexOf('<Fact\n          label="Kit"');
  const pulseira = review.indexOf('<Fact\n            label="Pulseira"');
  assert.ok(camiseta !== -1 && genero !== -1 && kit !== -1 && pulseira !== -1);
  assert.ok(camiseta < genero && genero < kit && kit < pulseira, "ordem precisa ser Camiseta, Gênero, Kit, Pulseira");
  assert.match(review, /turboGenderFromTicket\(participant\)/);
  assert.doesNotMatch(review, /turboGenderLabel\(participant\.gender\)/);
  assert.doesNotMatch(review, /fallback legado|inferido|legacy_profile/);
  assert.doesNotMatch(review, /full_name.*gender|gender.*full_name/);
});

test("genero operacional permanece visivel na etapa de pulseira, sem abrir Mais ações", () => {
  const body = slice(turbo, "screen.kind === 'scanning_wristband'", "screen.kind === 'ticket_success'");
  assert.match(body, /turboGenderFromTicket\(screen\.participant\)/);
  assert.doesNotMatch(body, /Mais ações/);
  assert.doesNotMatch(body, /fallback legado|inferido/);
});

test("DTO Turbo carrega turbo_gender com origem; cadastro fica em gender; fallback so para RAW importado", () => {
  const details = slice(actions, "async function buildTicketDetails(", "export async function getOperationTicketDetailsAction");
  const mapped = slice(actions, "function mapTicketRow(", "export async function listPickupParticipantsAction");
  assert.match(mapped, /orderItemRelation\?\.pricing_gender/);
  assert.match(details, /registration_contacts\(public_pin, gender\)/);
  assert.match(details, /participantGender = String\(baseRow\.gender \?\? ""\)\.trim\(\) \|\| null/);
  assert.match(details, /contactGender = String\(registrationContact\?\.gender \?\? ""\)\.trim\(\) \|\| null/);
  assert.match(details, /resolveTurboOperationalGender/);
  assert.match(details, /order_buyer_type: detailOrder\?\.buyer_type/);
  assert.match(details, /gender: storedGender/);
  assert.match(details, /pricing_gender: baseRow\.pricing_gender/);
  assert.match(details, /contact_gender: contactGender/);
  assert.match(details, /turbo_gender: turboGender/);
  assert.doesNotMatch(details, /from\("order_items"\)\.update|\.update\(\{[^}]*pricing_gender/);
  assert.doesNotMatch(details, /full_name.*masculin|infer.*gender|gender.*nome/i);
  assert.match(helper, /source: "pricing"/);
  assert.match(helper, /source: "legacy_profile"/);
  assert.match(helper, /source: "unknown"/);
  assert.match(helper, /Nunca persistir/);
});

test("check-in, kit, pulseira e QR do Turbo nao mudaram por causa do genero", () => {
  assert.match(turbo, /deliverKitAndCheckinAction/);
  assert.match(turbo, /deliverKitCheckinAndLinkWristbandAction/);
  assert.match(turbo, /kind: 'scanning_wristband'/);
  assert.match(turbo, /resolveTurboScanAction/);
  assert.doesNotMatch(slice(turbo, "async function handleNext", "async function handleWristbandScan"), /gender/);
  assert.doesNotMatch(slice(turbo, "async function handleWristbandScan", "return \("), /gender/);
});
