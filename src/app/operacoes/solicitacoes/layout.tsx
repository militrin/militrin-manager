import { requirePermission } from "@/lib/admin/permissions";

// Gate estrito, alem do gate solto ja aplicado por src/app/operacoes/layout.tsx.
// Mesma permissao ('kits.deliver') que a RPC review_ticket_item_change_request
// ja exige no backend -- ver auditoria do fluxo de aprovacao de alteracoes
// (P0). Chamada direta da RPC continua protegida por ela mesma
// independente desta tela.
export default async function OperacoesSolicitacoesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("kits.deliver");
  return <>{children}</>;
}
