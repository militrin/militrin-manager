import assert from "node:assert/strict";
import test from "node:test";
import { assertFrozenSnapshotInvariant, assertUniqueCommentIds, extractInstagramMentions, normalizeInstagramComment, normalizeUniqueInstagramComments, resolveOwnedInstagramMedia } from "../src/lib/instagram/normalize.ts";

test("autor oficial nunca e substituido pela primeira mencao", () => {
  const entry = normalizeInstagramComment({ id: "1789", from: { id: "42", username: "jaimir_meurer" }, text: "@raianabaierle @xuxu_pesca" }, 1, "https://www.instagram.com/p/teste/");
  assert.equal(entry.username, "jaimir_meurer");
  assert.equal(entry.mentions, "@raianabaierle @xuxu_pesca");
  assert.equal(entry.mentionsCount, 2);
});

test("cada comment_id permanece uma chance mesmo com o mesmo username", () => {
  const comments = ["a", "b"].map((id, index) => normalizeInstagramComment({ id, from: { username: "mesma_pessoa" }, text: "oi" }, index + 1, ""));
  assert.equal(comments.length, 2);
  assert.deepEqual(comments.map((item) => item.commentId), ["a", "b"]);
});

test("comment_id duplicado vindo da paginacao gera uma unica entrada", () => {
  const entries = normalizeUniqueInstagramComments([{ id: "a", from: { username: "pessoa" }, text: "um" }, { id: "a", from: { username: "pessoa" }, text: "um" }], "https://instagram.com/p/oficial/");
  assert.equal(entries.length, 1);
  assert.throws(() => assertUniqueCommentIds(["a", "a"]), /apenas uma vez/);
});

test("timestamp original do comentario e preservado", () => {
  const entry = normalizeInstagramComment({ id: "a", from: { username: "pessoa" }, text: "oi", timestamp: "2026-08-31T12:34:56+0000" }, 1, "");
  assert.equal(entry.commentCreatedAt, "2026-08-31T12:34:56+0000");
});

test("midia de outra conta e rejeitada e permalink oficial e resolvido", () => {
  const media = [{ id: "1", permalink: "https://instagram.com/p/oficial/" }];
  assert.equal(resolveOwnedInstagramMedia(media, "1").permalink, "https://instagram.com/p/oficial/");
  assert.throws(() => resolveOwnedInstagramMedia(media, "2"), /nao pertence/);
});

test("snapshot congelado rejeita entradas e origem diferentes", () => {
  const frozen = { source: "instagram", sourceFileName: null, instagramIntegrationId: "i1", instagramMediaId: "m1", instagramMediaPermalink: "https://instagram.com/p/1/", commentIds: ["c1", "c2"] };
  assert.doesNotThrow(() => assertFrozenSnapshotInvariant(frozen, { ...frozen, commentIds: ["c2", "c1"] }));
  assert.throws(() => assertFrozenSnapshotInvariant(frozen, { ...frozen, commentIds: ["c1", "c3"] }), /lista de participacoes/);
  assert.throws(() => assertFrozenSnapshotInvariant(frozen, { ...frozen, instagramMediaId: "m2" }), /origem ou publicacao/);
});

test("extrai mencoes apenas do texto e preserva ordem", () => {
  assert.deepEqual(extractInstagramMentions("ola @um, @dois! email@nao.e.mencao"), ["um", "dois"]);
});
