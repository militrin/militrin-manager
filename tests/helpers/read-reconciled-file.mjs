import { readFile as fsReadFile } from 'node:fs/promises';

/**
 * Migrations numeradas anteriores ao baseline sao fixtures historicas, nunca
 * migrations ativas. Testes de contrato leem a copia reconciliada no backup;
 * testes do estado atual devem ler o baseline timestampado diretamente.
 */
export async function readReconciledFile(resource, encoding = 'utf8') {
  const url = resource instanceof URL ? resource : new URL(resource, import.meta.url);
  const match = url.pathname.match(/\/supabase\/migrations\/(\d{3}_[^/]+\.sql)$/);
  if (match) return fsReadFile(new URL(`../../supabase/legacy_migrations_backup/${match[1]}`, import.meta.url), encoding);
  return fsReadFile(resource, encoding);
}
