import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";
import { turboGenderLabel } from "../src/lib/operations/turbo-gender-label.ts";

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const turbo = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8");

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

test("ficha QR identificado mostra Gênero entre Camiseta e Kit, no mesmo Fact dos demais cards", () => {
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  const camiseta = review.indexOf('<Fact label="Camiseta"');
  const genero = review.indexOf('<Fact label="Gênero"');
  const kit = review.indexOf('<Fact\n          label="Kit"');
  const pulseira = review.indexOf('<Fact\n            label="Pulseira"');
  assert.ok(camiseta !== -1 && genero !== -1 && kit !== -1 && pulseira !== -1);
  assert.ok(camiseta < genero && genero < kit && kit < pulseira, "ordem precisa ser Camiseta, Gênero, Kit, Pulseira");
  assert.match(review, /turboGenderLabel\(participant\.gender\)/);
  assert.doesNotMatch(review, /full_name.*gender|gender.*full_name/);
});

test("genero permanece visivel na etapa de pulseira, sem abrir Mais ações", () => {
  const body = slice(turbo, "screen.kind === 'scanning_wristband'", "screen.kind === 'ticket_success'");
  assert.match(body, /turboGenderLabel\(screen\.participant\.gender\)/);
  assert.doesNotMatch(body, /Mais ações/);
});

test("ficha do Turbo completa gender vazio do participant com o Cadastro, sem inferir pelo nome", () => {
  const details = slice(actions, "async function buildTicketDetails(", "export async function getOperationTicketDetailsAction");
  assert.match(details, /registration_contacts\(public_pin, gender\)/);
  assert.match(details, /storedGender = String\(baseRow\.gender \?\? ""\)\.trim\(\) \|\| String\(registrationContact\?\.gender \?\? ""\)\.trim\(\) \|\| null/);
  assert.match(details, /gender: storedGender/);
  assert.doesNotMatch(details, /full_name.*masculin|infer.*gender|gender.*nome/i);
});

test("check-in, kit, pulseira e QR do Turbo nao mudaram por causa do genero", () => {
  assert.match(turbo, /deliverKitAndCheckinAction/);
  assert.match(turbo, /deliverKitCheckinAndLinkWristbandAction/);
  assert.match(turbo, /kind: 'scanning_wristband'/);
  assert.match(turbo, /resolveTurboScanAction/);
  assert.doesNotMatch(slice(turbo, "async function handleNext", "async function handleWristbandScan"), /gender/);
  assert.doesNotMatch(slice(turbo, "async function handleWristbandScan", "return \("), /gender/);
});
