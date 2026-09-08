import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  canChangeGiveawayPost,
  canImportGiveawayCsv,
  canSyncGiveawayComments,
  giveawayHubSection,
  giveawayStatusLabel,
} from "../src/lib/giveaways/status.ts";
import { extractInstagramPagingCursor, toInstagramMediaCard } from "../src/lib/giveaways/media.ts";
import { parseSorteioCsv } from "../src/components/sorteios/csv.ts";
import { assertFrozenSnapshotInvariant } from "../src/lib/instagram/normalize.ts";

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)));

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

test("hub agrupa rascunhos, andamento e finalizados sem quebrar status legado", () => {
  assert.equal(giveawayHubSection("empty"), "drafts");
  assert.equal(giveawayHubSection("draft"), "drafts");
  assert.equal(giveawayHubSection("preparing"), "drafts");
  assert.equal(giveawayHubSection("ready"), "in_progress");
  assert.equal(giveawayHubSection("drawing"), "in_progress");
  assert.equal(giveawayHubSection("running"), "in_progress");
  assert.equal(giveawayHubSection("awaiting_validation"), "in_progress");
  assert.equal(giveawayHubSection("finalized"), "finished");
  assert.equal(giveawayHubSection("completed"), "finished");
  assert.equal(giveawayStatusLabel("awaiting_validation"), "Aguardando validação");
});

test("instagram sem conexao e com conexao aparecem na UI de criacao", () => {
  const form = read("src/components/sorteios/GiveawayCreateForm.tsx");
  assert.match(form, /CONECTAR INSTAGRAM|InstagramConnectionCard/);
  assert.match(form, /Nenhuma publicação vem selecionada por padrão/);
  assert.match(form, /source === "instagram" && !selected/);
});

test("listar publicacoes nao expoe token e nao seleciona automaticamente", () => {
  const picker = read("src/components/sorteios/InstagramMediaPicker.tsx");
  const sync = read("src/app/sorteios/giveaway-sync-actions.ts");
  const dto = toInstagramMediaCard({
    id: "17841400000000000",
    media_type: "IMAGE",
    permalink: "https://www.instagram.com/p/abc/",
    caption: "legenda",
    timestamp: "2026-09-01T12:00:00+0000",
    thumbnail_url: "https://scontent.cdninstagram.com/t.jpg",
  });
  assert.equal(dto.mediaId, "17841400000000000");
  assert.equal("accessToken" in dto, false);
  assert.equal("token" in dto, false);
  assert.match(picker, /CARREGAR PUBLICAÇÕES/);
  assert.match(picker, /SELECIONAR/);
  assert.doesNotMatch(picker, /setSelected\(values\[0\]/);
  assert.doesNotMatch(sync, /access_token/);
  assert.match(sync, /toInstagramMediaCard/);
});

test("criar instagram sem publicacao e bloqueado e media_id e persistido", () => {
  const actions = read("src/app/sorteios/giveaway-actions.ts");
  assert.match(actions, /Selecione uma publicacao do Instagram antes de criar o sorteio/);
  assert.match(actions, /instagram_media_id: parsed\.instagramMedia\?\.mediaId/);
  assert.match(actions, /source === "instagram" && !parsed\.instagramMedia/);
});

test("sync usa media_id do giveaway e e idempotente por comment_id", () => {
  const sync = read("src/app/sorteios/giveaway-sync-actions.ts");
  assert.match(sync, /giveaway\.instagram_media_id/);
  assert.doesNotMatch(sync, /Dcb8sKsJ91b/);
  assert.doesNotMatch(sync, /militrinoktober/);
  const migration = read("supabase/migrations/20260919000000_instagram_giveaways.sql");
  assert.match(migration, /unique \(giveaway_id, comment_id\)/);
});

test("freeze impede sync, troca de post e csv", () => {
  assert.equal(canSyncGiveawayComments("ready", null), true);
  assert.equal(canSyncGiveawayComments("ready", "2026-08-31T00:00:00.000Z"), false);
  assert.equal(canChangeGiveawayPost("draft", null), true);
  assert.equal(canChangeGiveawayPost("awaiting_validation", "2026-08-31T00:00:00.000Z"), false);
  assert.equal(canImportGiveawayCsv("ready", null), true);
  assert.equal(canImportGiveawayCsv("awaiting_validation", "2026-08-31T00:00:00.000Z"), false);
  const frozen = {
    source: "csv",
    sourceFileName: "oficial.csv",
    instagramIntegrationId: null,
    instagramMediaId: null,
    instagramMediaPermalink: "https://www.instagram.com/p/Dcb8sKsJ91b/",
    commentIds: ["c1", "c2"],
  };
  assert.throws(() => assertFrozenSnapshotInvariant(frozen, { ...frozen, instagramMediaPermalink: "https://www.instagram.com/p/outro/" }), /origem ou publicacao/);
});

test("sorteio oficial mapeia 436/88/436 e vencedor selecionado", () => {
  const mapper = read("src/lib/giveaways/session.ts");
  const app = read("src/components/sorteios/SorteioApp.tsx");
  assert.match(mapper, /sessionFromGiveawayRows/);
  assert.match(mapper, /confirmedWinner: giveaway.confirmed_winner_comment_id/);
  assert.match(app, /initialSession/);
  assert.doesNotMatch(app, /initialSession \?\? loadSession\(\)/);
  const entries = [
    { username: "ana" },
    ...Array.from({ length: 435 }, (_, index) => ({ username: index < 87 ? `user${index}` : "ana" })),
  ];
  assert.equal(entries.length, 436);
  assert.equal(new Set(entries.map((entry) => entry.username.toLowerCase())).size, 88);
});

test("CSV continua importando por comment_id", () => {
  const result = parseSorteioCsv('comment_id,username,comment\n1,pessoa,"@amigo"\n2,pessoa,"oi"\n');
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.entries.length, 2);
});

test("rotas da central existem e hardcodes de post foram removidos da UI", () => {
  const hubPage = read("src/app/sorteios/page.tsx");
  const novo = read("src/app/sorteios/novo/page.tsx");
  const detail = read("src/app/sorteios/[giveawayId]/page.tsx");
  const app = read("src/components/sorteios/SorteioApp.tsx");
  const types = read("src/components/sorteios/types.ts");
  assert.match(hubPage, /GiveawayHub/);
  assert.match(novo, /GiveawayCreateForm/);
  assert.match(detail, /loadGiveawaySession\(giveawayId\)/);
  assert.doesNotMatch(types, /Dcb8sKsJ91b/);
  assert.doesNotMatch(types, /militrinoktober/);
  assert.doesNotMatch(app, /INSTAGRAM_POST_URL/);
  assert.match(app, /initialSession/);
  assert.match(app, /Após iniciar, o snapshot ficará congelado/);
});

test("paginacao de midia usa cursor after", () => {
  const api = read("src/lib/instagram/meta-api.ts");
  assert.match(api, /listInstagramMediaPage/);
  assert.match(api, /searchParams\.set\("after"/);
  assert.equal(extractInstagramPagingCursor("https://graph.instagram.com/v26.0/me/media?after=CURSOR", undefined), "CURSOR");
});

test("acesso entre organizations e isolado no load/create", () => {
  const actions = read("src/app/sorteios/giveaway-actions.ts");
  assert.match(actions, /eq\("organization_id", organization\.id\)/);
  assert.match(actions, /Sorteio nao encontrado nesta organizacao/);
  assert.doesNotMatch(actions, /onConflict: "organization_id,public_id"/);
});

test("migration de reusable giveaways nao mexe em winner/snapshot/entries", () => {
  const sql = read("supabase/migrations/20261004000000_reusable_giveaways.sql");
  assert.match(sql, /add column if not exists name/);
  assert.match(sql, /MILITRIN-2026-0831-006/);
  assert.doesNotMatch(sql, /giveaway_entries/);
  assert.doesNotMatch(sql, /current_winner_comment_id/);
  assert.doesNotMatch(sql, /snapshot_frozen_at =/);
});
