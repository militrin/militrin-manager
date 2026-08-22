/** Rotulo legivel por modulo de admin_permissions.module -- fonte unica, reusada pelo editor por usuario ([userId]/access-editor.tsx) e pelo editor por funcao (funcoes/[roleId]/role-permissions-editor.tsx). */
export function moduleLabel(module: string) {
  const map: Record<string, string> = {
    dashboard: 'Dashboard',
    participants: 'Participantes',
    orders: 'Pedidos',
    finance: 'Financeiro',
    inventory: 'Camisetas e estoque',
    kits: 'Kits',
    checkin: 'Check-in',
    events: 'Eventos',
    batches: 'Lotes',
    categories: 'Categorias',
    coupons: 'Cupons',
    photos: 'Fotos',
    imports: 'Importacoes',
    reports: 'Relatorios',
    store: 'Loja',
    team: 'Equipe e seguranca',
    security: 'Equipe e seguranca',
    settings: 'Equipe e seguranca',
  };
  return map[module] ?? module;
}
