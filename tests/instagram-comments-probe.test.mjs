import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "path";
import {
  createInstagramPaginationGuard,
  INSTAGRAM_COMMENTS_PAGE_LIMIT,
  instagramPaginationFingerprint,
  logicalGraphEndpoint,
  walkInstagramPages,
} from "../src/lib/instagram/graph-pagination.ts";
import { normalizeUniqueInstagramComments } from "../src/lib/instagram/normalize.ts";

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)));

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

test("comments usa limit 50 e guarda cursor repetido", () => {
  const api = read("src/lib/instagram/meta-api.ts");
  assert.match(api, /INSTAGRAM_COMMENTS_PAGE_LIMIT/);
  assert.match(api, /walkInstagramPages/);
  assert.doesNotMatch(api, /comments\?fields=id,from,text,timestamp&limit=100/);
  assert.equal(INSTAGRAM_COMMENTS_PAGE_LIMIT, 50);
});

test("fingerprint de paginacao ignora access_token e detecta after repetido", () => {
  const first = "https://graph.instagram.com/v26.0/1/comments?fields=id&limit=50";
  const nextA = "https://graph.instagram.com/v26.0/1/comments?after=AAA&access_token=secret";
  const nextB = "https://graph.instagram.com/v26.0/1/comments?after=AAA&limit=50";
  const nextC = "https://graph.instagram.com/v26.0/1/comments?after=BBB";
  assert.notEqual(instagramPaginationFingerprint(first), instagramPaginationFingerprint(nextA));
  assert.equal(instagramPaginationFingerprint(nextA), instagramPaginationFingerprint(nextB));
  assert.notEqual(instagramPaginationFingerprint(nextA), instagramPaginationFingerprint(nextC));
  const guard = createInstagramPaginationGuard();
  assert.equal(guard.shouldStop(nextA), false);
  assert.equal(guard.shouldStop(nextB), true);
  assert.equal(guard.shouldStop(nextC), false);
  assert.equal(logicalGraphEndpoint("https://graph.instagram.com/v26.0/me/media"), "me/media");
  assert.equal(logicalGraphEndpoint("https://graph.instagram.com/v26.0/17841400000000000/comments"), "comments");
});

test("comentarios percorre todas as paginas, para cursor repetido e deduplica", async () => {
  const pages = new Map([
    ["https://graph.instagram.com/v26.0/1/comments", {
      data: [
        { id: "c1", username: "ana", text: "@amigo" },
        { id: "c2", from: { username: "bia" }, text: "oi" },
      ],
      next: "https://graph.instagram.com/v26.0/1/comments?after=AAA",
    }],
    ["https://graph.instagram.com/v26.0/1/comments?after=AAA", {
      data: [
        { id: "c2", from: { username: "bia" }, text: "oi" },
        { id: "c3", username: "caio", text: "eu" },
      ],
      next: "https://graph.instagram.com/v26.0/1/comments?after=AAA",
    }],
  ]);

  const walked = await walkInstagramPages("https://graph.instagram.com/v26.0/1/comments", async (url) => {
    const page = pages.get(url);
    assert.ok(page, `pagina inesperada ${url}`);
    return { ok: true, data: page.data, next: page.next };
  });

  assert.equal(walked.ok, true);
  if (!walked.ok) return;
  assert.equal(walked.pagesFetched, 2);
  assert.equal(walked.stoppedOnRepeatedCursor, true);
  assert.equal(walked.items.length, 4);

  const entries = normalizeUniqueInstagramComments(walked.items, "https://www.instagram.com/p/oficial/");
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.commentId), ["c1", "c2", "c3"]);
  assert.deepEqual(entries.map((entry) => entry.username), ["ana", "bia", "caio"]);
  assert.ok(entries.every((entry) => entry.status === "active"));
});

test("endpoint diagnostico comments-probe foi removido", () => {
  const api = read("src/lib/instagram/meta-api.ts");
  const runtime = read("src/lib/instagram/runtime-integration.ts");
  const middleware = read("middleware.ts");
  assert.doesNotMatch(api, /comments-probe/);
  assert.doesNotMatch(runtime, /requireConnectedInstagramIntegrationReadOnly/);
  assert.doesNotMatch(middleware, /comments-probe/);
  assert.throws(() => read("src/app/api/instagram/comments-probe/route.ts"), /ENOENT/);
  assert.throws(() => read("src/lib/instagram/comments-read-only-probe.ts"), /ENOENT/);
});
