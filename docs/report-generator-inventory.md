# Inventário de relatórios e PDFs

## Geradores ativos

| Gerador | Arquivo | Execução | Estado do tema compartilhado |
|---|---|---|---|
| Histórico administrativo do ingresso (PDF/CSV) | `src/lib/admin/ticket-timeline.ts` | Servidor | Migrado |
| Impressão do histórico administrativo | `src/app/ingressos/[ticketId]/timeline-panel.tsx` | Navegador | Migrado |
| PDF do ingresso e QR | `src/components/public/TicketPdfButton.tsx` | Navegador | Migrado |
| Comprovante de pagamento | `src/components/public/PaymentReceiptPdfButton.tsx` | Navegador | Migrado |

## Telas de relatório sem exportador próprio

- `src/app/relatorios/page.tsx`: dashboard administrativo; ainda não gera PDF ou impressão.
- `src/app/inscricoes/[id]/history.tsx`: histórico em tela; ainda não possui layout de impressão.

Novos geradores administrativos devem reutilizar `src/lib/reports/report-theme.ts` para cores, A4, margens, datas, rodapé e identificadores técnicos.
