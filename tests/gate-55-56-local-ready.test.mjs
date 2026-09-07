import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

const LOCAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

test('migrations ate 56 estao em ordem cronologica e 55/56 existem antes de 57', async () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(names.includes('20260955000000_single_ticket_unisex_lots.sql'));
  assert.ok(names.includes('20260956000000_organization_notifications.sql'));
  const index55 = names.indexOf('20260955000000_single_ticket_unisex_lots.sql');
  const index56 = names.indexOf('20260956000000_organization_notifications.sql');
  const index57 = names.indexOf('20260957000000_data_deletion_requests.sql');
  assert.equal(index56, index55 + 1);
  assert.ok(index57 === -1 || index57 > index56);
  const stamps = names.map((name) => name.slice(0, 14));
  assert.deepEqual(stamps, [...stamps].sort());
});

test('supabase local em 127.0.0.1:54321 esta no ar para o replay 1→56', async () => {
  let reachable = false;
  let detail = 'sem resposta';
  try {
    const response = await fetch('http://127.0.0.1:54321/auth/v1/health', {
      headers: { apikey: LOCAL_ANON },
      signal: AbortSignal.timeout(3000),
    });
    reachable = response.status > 0;
    detail = `HTTP ${response.status}`;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  assert.ok(
    reachable,
    `BLOQUEADO: Supabase local nao responde (${detail}). Docker Desktop permanece em status=starting sem dockerd (HTTP 503 no engine). Replay 1→56 e E2E local nao executados. Nao aplicar 55/56 em Production.`,
  );
});
