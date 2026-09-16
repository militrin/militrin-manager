import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toInstagramMediaCard } from "../src/lib/giveaways/media.ts";
import {
  classifyInstagramGraphFailure,
  instagramCommentsSyncUserCopy,
  instagramMediaLoadUserCopy,
  logInstagramGraphEvent,
  readMetaError,
  sanitizeMetaErrorMessage,
} from "../src/lib/instagram/meta-error.ts";

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("classifica erros da Meta sem vazar token", () => {
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 401, errorCode: 190 }), "expired_token");
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 400, errorSubcode: 463 }), "expired_token");
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 403, errorCode: 10 }), "permission");
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 400, errorCode: 200 }), "permission");
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 400, errorSubcode: 33 }), "permission");
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 429, errorCode: 4 }), "rate_limit");
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 404, errorCode: 100 }), "media_not_found");
  assert.equal(classifyInstagramGraphFailure({ httpStatus: 500 }), "unknown");
  assert.equal(classifyInstagramGraphFailure({ timedOut: true }), "timeout");
  assert.equal(classifyInstagramGraphFailure({ jsonParseFailed: true, httpStatus: 200 }), "invalid_response");
  assert.equal(classifyInstagramGraphFailure({ networkError: true, httpStatus: 0 }), "network");

  const details = readMetaError(400, {
    error: {
      code: 100,
      error_subcode: 33,
      type: "IGApiException",
      message: "Unsupported get request. access_token=SECRETTOKENVALUE123456789012345",
      fbtrace_id: "A1b2C3d4E5f6G7h8",
    },
  });
  assert.equal(details.errorCode, 100);
  assert.equal(details.errorSubcode, 33);
  assert.equal(details.fbtraceId, "A1b2C3d4E5f6G7h8");
  assert.doesNotMatch(details.sanitizedMessage, /SECRETTOKENVALUE/);
  assert.match(sanitizeMetaErrorMessage("falhou https://graph.instagram.com/x access_token=abc"), /\[url\]/);
});

test("copy de erro da listagem nao usa digest do Next", () => {
  const expired = instagramMediaLoadUserCopy("expired_token");
  const permission = instagramMediaLoadUserCopy("permission");
  const timeout = instagramMediaLoadUserCopy("timeout");
  const commentsPermission = instagramCommentsSyncUserCopy("permission");
  assert.equal(expired.message, "Não foi possível carregar as publicações do Instagram.");
  assert.equal(expired.detail, "A conexão com o Instagram expirou. Reconecte a conta.");
  assert.equal(expired.reconnectRequired, true);
  assert.equal(permission.message, "Não foi possível carregar as publicações do Instagram.");
  assert.equal(permission.detail, "A Meta negou a permissão necessária para consultar esta conta.");
  assert.equal(permission.reconnectRequired, true);
  assert.equal(timeout.reconnectRequired, false);
  assert.equal(commentsPermission.message, "Não foi possível sincronizar os comentários do Instagram.");
  assert.doesNotMatch(expired.message, /Server Components/);
  assert.doesNotMatch(permission.detail, /digest/i);
});

test("cards aceitam caption nula, reel, carousel e imagem sem thumbnail", () => {
  const image = toInstagramMediaCard({ id: "1", media_type: "IMAGE", permalink: "https://www.instagram.com/p/a/", caption: undefined, timestamp: "2026-09-01T12:00:00+0000", media_url: "https://scontent.cdninstagram.com/i.jpg" });
  const reel = toInstagramMediaCard({ id: "2", media_type: "VIDEO", permalink: "https://www.instagram.com/reel/b/", caption: "", timestamp: "", thumbnail_url: "https://scontent.cdninstagram.com/t.jpg" });
  const reelsAlias = toInstagramMediaCard({ id: "4", media_type: "REELS", permalink: "https://www.instagram.com/reel/d/", timestamp: "2026-09-03T12:00:00+0000" });
  const carousel = toInstagramMediaCard({ id: "3", media_type: "CAROUSEL_ALBUM", permalink: "https://www.instagram.com/p/c/", caption: "kit", timestamp: "2026-09-02T12:00:00+0000" });
  const empty = [];
  assert.equal(image.caption, "");
  assert.equal(image.thumbnailUrl, "https://scontent.cdninstagram.com/i.jpg");
  assert.equal(reel.mediaType, "VIDEO");
  assert.equal(reel.caption, "");
  assert.equal(reelsAlias.mediaType, "REELS");
  assert.equal(reelsAlias.thumbnailUrl, "");
  assert.equal(carousel.mediaType, "CAROUSEL_ALBUM");
  assert.equal(carousel.thumbnailUrl, "");
  assert.equal(empty.length, 0);
});

test("server action de midia devolve resultado e nao lanca erro da Meta", () => {
  const sync = read("src/app/sorteios/giveaway-sync-actions.ts");
  const api = read("src/lib/instagram/meta-api.ts");
  const picker = read("src/components/sorteios/InstagramMediaPicker.tsx");
  const runtime = read("src/lib/instagram/runtime-integration.ts");
  assert.match(sync, /LoadInstagramMediaPageResult/);
  assert.match(sync, /SyncGiveawayCommentsResult/);
  assert.match(sync, /reconnectRequired/);
  assert.match(sync, /actionFailure/);
  assert.match(sync, /ok: false/);
  assert.match(sync, /isNextControlFlowError/);
  assert.doesNotMatch(sync, /throw new Error\("O app nao possui/);
  assert.match(api, /objectId: "me"/);
  assert.match(api, /INSTAGRAM_GRAPH_TIMEOUT_MS = 15_000/);
  assert.match(api, /readGraphBody/);
  assert.match(api, /jsonParseFailed/);
  assert.match(api, /shouldFallbackToStoredUser/);
  assert.match(picker, /if \(!page\.ok\)/);
  assert.match(picker, /Reconectar Instagram/);
  assert.match(picker, /Tentar novamente/);
  assert.match(picker, /Nenhuma publicação disponível foi encontrada/);
  assert.doesNotMatch(picker, /value instanceof Error \? value\.message/);
  assert.match(runtime, /token_refresh_skipped/);
  assert.match(runtime, /refresh_failed_keep_current_token/);
});

test("lista vazia so ocorre em resultado ok e log nao guarda token", () => {
  const picker = read("src/components/sorteios/InstagramMediaPicker.tsx");
  const api = read("src/lib/instagram/meta-api.ts");
  const error = read("src/lib/instagram/meta-error.ts");
  assert.match(picker, /loaded && !pending && !error && items\.length === 0/);
  assert.match(api, /return \{ ok: true, items, nextCursor/);
  assert.match(error, /FORBIDDEN_LOG_KEYS/);
  const lines = [];
  const original = console.info;
  console.info = (...args) => { lines.push(args.join(" ")); };
  try {
    logInstagramGraphEvent({
      operation: "media_page",
      endpoint: "me/media",
      access_token: "SHOULD_NOT_APPEAR_TOKEN_VALUE_1234567890",
      token: "also-secret",
      httpStatus: 403,
      errorCode: 10,
      kind: "permission",
    });
  } finally {
    console.info = original;
  }
  const payload = lines.join("\n");
  assert.match(payload, /\[instagram-graph\]/);
  assert.doesNotMatch(payload, /SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(payload, /also-secret/);
  assert.match(payload, /"errorCode":10/);
});
