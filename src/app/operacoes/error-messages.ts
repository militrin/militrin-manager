/**
 * Titulo amigavel para o OperationalErrorDialog a partir do `code`/`message`
 * ja devolvidos pelas server actions (operationRpcError em actions.ts, ou o
 * texto puro que algumas RPCs ja levantam em PT-BR). Nao inventa nenhum
 * codigo novo -- so mapeia os codigos e mensagens que o backend ja usa pra
 * um titulo curto de popup. Quando nada bate, cai num titulo generico (nunca
 * mostra o codigo tecnico cru pro operador).
 */
export function getOperationalErrorTitle(code: string | undefined, message: string): string {
  if (code === "SHIRT_OUT_OF_STOCK" || code === "PRODUCT_OUT_OF_STOCK") return "Estoque insuficiente";
  if (code === "HOLDER_ALREADY_HAS_TICKET_FOR_EVENT") return "Titular já possui ingresso";
  if (code === "SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION") return "Alteração bloqueada";

  const normalized = message.toLowerCase();
  if (normalized.includes("estoque insuficiente") || normalized.includes("sem estoque") || normalized.includes("nao ha estoque") || normalized.includes("não há estoque")) {
    return "Estoque insuficiente";
  }
  if (normalized.includes("ja foi utilizado") || normalized.includes("já foi utilizado")) return "Ingresso já utilizado";
  if (normalized.includes("kit ja foi entregue") || normalized.includes("kit já foi entregue")) return "Kit já entregue";
  if (normalized.includes("cancelad")) return "Ingresso cancelado";
  if (normalized.includes("pulseira ja vinculada") || normalized.includes("pulseira já vinculada")) return "Pulseira já utilizada";
  if (normalized.includes("ja possui uma pulseira") || normalized.includes("já possui uma pulseira")) return "Pulseira já vinculada";
  if (normalized.includes("sem permissao") || normalized.includes("sem permissão")) return "Permissão negada";
  if (normalized.includes("invalido") || normalized.includes("inválido") || normalized.includes("nao encontrado") || normalized.includes("não encontrado")) return "Ingresso inválido";
  if (normalized.includes("pagamento pendente")) return "Pagamento pendente";

  return "Não foi possível concluir a operação";
}
