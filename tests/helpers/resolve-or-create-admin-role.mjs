// Find-or-create de admin_roles seguro contra corrida entre arquivos de teste
// executados em paralelo pelo runner (`node --test tests/payment-gateway-*.mjs`
// carrega/roda todos os arquivos ao mesmo tempo -- se dois deles fizerem
// find-or-create do mesmo role de sistema ('owner', por exemplo) no mesmo
// instante, um SELECT vazio em ambos seguido de dois INSERT concorrentes
// viola admin_roles_code_key). Sempre reconsulta apos um 23505 em vez de
// deixar o teste falhar.
export async function resolveOrCreateAdminRole(service, code, name) {
  const existing = await service.from('admin_roles').select('id').eq('code', code).maybeSingle();
  if (existing.error) throw new Error(`admin_roles select ${code}: ${JSON.stringify(existing.error)}`);
  if (existing.data) return existing.data;

  const inserted = await service.from('admin_roles').insert({ code, name, is_system: true, is_active: true }).select('id').single();
  if (!inserted.error) return inserted.data;

  if (inserted.error.code === '23505') {
    const retry = await service.from('admin_roles').select('id').eq('code', code).single();
    if (retry.error) throw new Error(`admin_roles retry select ${code}: ${JSON.stringify(retry.error)}`);
    return retry.data;
  }

  throw new Error(`admin_roles insert ${code}: ${JSON.stringify(inserted.error)}`);
}
