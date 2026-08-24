import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "./types";
import { vendasFunil, vendasPedidos } from "./queries/vendas";
import { kitsPorOperador, kitsEntregasDetalhado } from "./queries/kits";
import { pulseirasResumo, pulseirasHistorico } from "./queries/pulseiras";
import { estoqueSaldo, estoqueMovimentacoes } from "./queries/estoque";
import { financeiroDre, financeiroLancamentos } from "./queries/financeiro";
import { cuponsUso, cuponsResgates } from "./queries/cupons";
import { importacoesTaxaErro, importacoesPendencias } from "./queries/importacoes";
import { equipeRanking, equipeAuditoria } from "./queries/equipe";
import { lojaFaturamento, lojaPedidos } from "./queries/loja";
import { eventosOcupacao, eventosLotesHistorico } from "./queries/eventos";
import { contasConversao, contasConvites } from "./queries/contas";
import { operacoesHistorico, operacoesContingencia } from "./queries/operacoes";

type ReportQueryFn = (supabase: ReportSupabaseClient, ctx: ReportQueryContext) => Promise<ReportResult>;

export const REPORT_REGISTRY: Record<string, ReportQueryFn> = {
  "vendas-funil": vendasFunil,
  "vendas-pedidos": vendasPedidos,
  "kits-por-operador": kitsPorOperador,
  "kits-entregas-detalhado": kitsEntregasDetalhado,
  "pulseiras-resumo": pulseirasResumo,
  "pulseiras-historico": pulseirasHistorico,
  "estoque-saldo": estoqueSaldo,
  "estoque-movimentacoes": estoqueMovimentacoes,
  "financeiro-dre": financeiroDre,
  "financeiro-lancamentos": financeiroLancamentos,
  "cupons-uso": cuponsUso,
  "cupons-resgates": cuponsResgates,
  "importacoes-taxa-erro": importacoesTaxaErro,
  "importacoes-pendencias": importacoesPendencias,
  "equipe-ranking": equipeRanking,
  "equipe-auditoria": equipeAuditoria,
  "loja-faturamento": lojaFaturamento,
  "loja-pedidos": lojaPedidos,
  "eventos-ocupacao": eventosOcupacao,
  "eventos-lotes-historico": eventosLotesHistorico,
  "contas-conversao": contasConversao,
  "contas-convites": contasConvites,
  "operacoes-historico": operacoesHistorico,
  "operacoes-contingencia": operacoesContingencia,
};
