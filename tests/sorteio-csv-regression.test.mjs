import assert from "node:assert/strict";
import test from "node:test";
import { parseSorteioCsv } from "../src/components/sorteios/csv.ts";

test("CSV legado continua importando por comment_id sem deduplicar username", () => {
  const result = parseSorteioCsv('comment_id,username,comment,mentions\n1,mesma_pessoa,"@amigo um",@amigo\n2,mesma_pessoa,"@outro dois",@outro\n');
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map((entry) => entry.commentId), ["1", "2"]);
});

test("CSV legado rejeita comment_id repetido", () => {
  const result = parseSorteioCsv('comment_id,username,comment\n1,pessoa,primeiro\n1,pessoa,segundo\n');
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.entries.length, 1);
  assert.equal(result.summary.duplicateCommentIdsSkipped, 1);
});
