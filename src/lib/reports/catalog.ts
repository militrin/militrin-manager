export type ReportCategory =
  | "vendas"
  | "kits"
  | "pulseiras"
  | "estoque"
  | "financeiro"
  | "cupons"
  | "importacoes"
  | "equipe"
  | "loja"
  | "eventos"
  | "contas"
  | "operacoes";

export type ReportKind = "simplificado" | "detalhado";

export type ReportDefinition = {
  id: string;
  label: string;
  category: ReportCategory;
  kind: ReportKind;
  description: string;
  permission: string | string[];
  needsEvent: "required" | "optional" | "none";
  needsDateRange: boolean;
};

export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  vendas: "Vendas e inscrições",
  kits: "Kits e entrega de itens",
  pulseiras: "Pulseiras",
  estoque: "Camisetas / estoque",
  financeiro: "Financeiro",
  cupons: "Cupons",
  importacoes: "Importações",
  equipe: "Equipe / auditoria",
  loja: "Loja",
  eventos: "Eventos / lotes",
  contas: "Contas / convites",
  operacoes: "Operações",
};

export const REPORT_CATALOG: ReportDefinition[] = [
  {
    id: "vendas-funil",
    label: "Funil de vendas e ticket médio",
    category: "vendas",
    kind: "simplificado",
    description: "Pedidos por status, ticket médio, taxa de cancelamento e de expiração de reserva.",
    permission: "participants.view",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "vendas-pedidos",
    label: "Lista de pedidos",
    category: "vendas",
    kind: "detalhado",
    description: "Pedidos individuais com status, valores, forma de pagamento e comprador.",
    permission: "participants.view",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "kits-por-operador",
    label: "Kits entregues por dia e por operador",
    category: "kits",
    kind: "simplificado",
    description: "Volume de entregas de itens agregado por dia e por operador responsável.",
    permission: "kits.view",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "kits-entregas-detalhado",
    label: "Entregas de kit, item a item",
    category: "kits",
    kind: "detalhado",
    description: "Qual item foi entregue, para quem e por qual operador.",
    permission: "kits.view",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "pulseiras-resumo",
    label: "Pulseiras vinculadas vs. bloqueadas/perdidas",
    category: "pulseiras",
    kind: "simplificado",
    description: "Totais por status de pulseira no evento.",
    permission: "wristbands.view",
    needsEvent: "required",
    needsDateRange: false,
  },
  {
    id: "pulseiras-historico",
    label: "Histórico de pulseiras",
    category: "pulseiras",
    kind: "detalhado",
    description: "Vínculo, desvínculo, bloqueio e substituição por pulseira, com operador.",
    permission: "wristbands.view",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "estoque-saldo",
    label: "Saldo disponível por modelo e tamanho",
    category: "estoque",
    kind: "simplificado",
    description: "Total recebido, reservado, entregue e disponível de camisetas.",
    permission: "inventory.view",
    needsEvent: "required",
    needsDateRange: false,
  },
  {
    id: "estoque-movimentacoes",
    label: "Movimentações de estoque",
    category: "estoque",
    kind: "detalhado",
    description: "Encomendas, ajustes, devoluções e perdas, com motivo.",
    permission: "inventory.view_history",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "financeiro-dre",
    label: "DRE simplificado por evento",
    category: "financeiro",
    kind: "simplificado",
    description: "Receita x despesa por categoria financeira, ratiada por evento.",
    permission: "finance.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "financeiro-lancamentos",
    label: "Lançamentos do razão",
    category: "financeiro",
    kind: "detalhado",
    description: "Lançamentos com status, categoria, fornecedor e estornos.",
    permission: "finance.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "cupons-uso",
    label: "Uso de cupons",
    category: "cupons",
    kind: "simplificado",
    description: "Resgates por cupom frente ao limite, e desconto total concedido.",
    permission: "coupons.view_usage",
    needsEvent: "required",
    needsDateRange: false,
  },
  {
    id: "cupons-resgates",
    label: "Resgates de cupom",
    category: "cupons",
    kind: "detalhado",
    description: "Cada resgate individual: cupom, participante, valores e data.",
    permission: "coupons.view_usage",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "importacoes-taxa-erro",
    label: "Taxa de erro/pendência por lote importado",
    category: "importacoes",
    kind: "simplificado",
    description: "Linhas importadas, ignoradas e com erro por lote de importação.",
    permission: "imports.view",
    needsEvent: "optional",
    needsDateRange: false,
  },
  {
    id: "importacoes-pendencias",
    label: "Pendências cadastrais em aberto",
    category: "importacoes",
    kind: "detalhado",
    description: "Pendências por campo e o que cada uma bloqueia.",
    permission: "imports.view",
    needsEvent: "optional",
    needsDateRange: false,
  },
  {
    id: "equipe-ranking",
    label: "Ranking de ações por operador",
    category: "equipe",
    kind: "simplificado",
    description: "Volume de ações registradas em auditoria por operador e por dia.",
    permission: "audit.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "equipe-auditoria",
    label: "Trilha de auditoria",
    category: "equipe",
    kind: "detalhado",
    description: "Toda ação registrada, com operador, entidade e data.",
    permission: "audit.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "loja-faturamento",
    label: "Faturamento da loja e itens mais vendidos",
    category: "loja",
    kind: "simplificado",
    description: "Receita da loja por período e ranking de itens vendidos.",
    permission: "store.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "loja-pedidos",
    label: "Pedidos da loja",
    category: "loja",
    kind: "detalhado",
    description: "Pedidos da loja com status de entrega por item.",
    permission: "store.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "eventos-ocupacao",
    label: "Ocupação por categoria e lote",
    category: "eventos",
    kind: "simplificado",
    description: "Vagas confirmadas frente à capacidade/limite de cada categoria e lote.",
    permission: "events.view",
    needsEvent: "required",
    needsDateRange: false,
  },
  {
    id: "eventos-lotes-historico",
    label: "Histórico de avanço de lote",
    category: "eventos",
    kind: "detalhado",
    description: "Quando cada lote foi ativado/avançado automaticamente.",
    permission: "events.view",
    needsEvent: "required",
    needsDateRange: false,
  },
  {
    id: "contas-conversao",
    label: "Conversão de convites de primeiro acesso",
    category: "contas",
    kind: "simplificado",
    description: "Convites enviados x aceitos, e tempo médio até o aceite.",
    permission: "participants.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "contas-convites",
    label: "Lista de convites",
    category: "contas",
    kind: "detalhado",
    description: "Convites pendentes, aceitos, expirados e revogados.",
    permission: "participants.view",
    needsEvent: "optional",
    needsDateRange: true,
  },
  {
    id: "operacoes-historico",
    label: "Histórico de Operações",
    category: "operacoes",
    kind: "detalhado",
    description: "Log imutável de ações operacionais (kit, check-in, pulseira, camiseta, titular, itens adicionais), com operador e motivo. Reversões geram uma linha nova, nunca reescrevem a anterior.",
    permission: "operations.view_report",
    needsEvent: "required",
    needsDateRange: true,
  },
  {
    id: "operacoes-contingencia",
    label: "Snapshot de Contingência",
    category: "operacoes",
    kind: "simplificado",
    description: "Estado atual de cada ingresso (titular, comprador, camiseta, kit, check-in, pulseira, itens adicionais) para baixar e usar offline no dia do evento.",
    permission: "operations.view_report",
    needsEvent: "required",
    needsDateRange: false,
  },
];
