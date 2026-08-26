// Rotulo amigavel para o status de um item de kit (camiseta, brinde, etc.) no
// resumo do checkout publico -- nunca a string tecnica do banco
// ('reserved'/'confirmed'/'delivered'). 'cancelled' nunca chega aqui: item
// cancelado e filtrado antes, na fonte canonica (ver getUnifiedOrderKitItems
// em src/app/inscricao/actions.ts) -- nao e um item ativo do kit.
export function kitItemStatusLabel(status: "reserved" | "confirmed" | "delivered"): string {
  if (status === "delivered") return "Entregue";
  return "A retirar";
}
