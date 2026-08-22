import { HelpCircle, LayoutList, Tag, Ticket } from "lucide-react";

export type EventResumeCardData = {
  ticketModeLabel: string;
  activeCategoryCount: number;
  totalCategoryCount: number;
  totalBatchCount: number;
  ticketsCount: number;
  singleTicketMaleBatchLabel?: string | null;
  singleTicketFemaleBatchLabel?: string | null;
  singleTicketBatchesDiffer?: boolean;
};

// Resumo rapido do que ja esta configurado no evento, para o admin nao precisar
// abrir cada etapa so para lembrar o estado atual.
export function EventResumeCard({ data }: { data: EventResumeCardData }) {
  const rows = [
    { icon: Tag, label: "Modelo de ingresso", value: data.ticketModeLabel },
    { icon: LayoutList, label: "Categorias ativas", value: `${data.activeCategoryCount} de ${data.totalCategoryCount}` },
    { icon: Ticket, label: "Lotes cadastrados", value: String(data.totalBatchCount) },
    ...(data.singleTicketBatchesDiffer
      ? [
          { icon: Ticket, label: "Lote atual masc.", value: data.singleTicketMaleBatchLabel ?? "—" },
          { icon: Ticket, label: "Lote atual fem.", value: data.singleTicketFemaleBatchLabel ?? "—" },
        ]
      : []),
    { icon: Ticket, label: "Ingressos emitidos", value: String(data.ticketsCount) },
  ];

  return (
    <aside className="rounded-2xl border border-slate-800 bg-slate-950/60">
      <div className="border-b border-slate-800 px-4 py-3">
        <p className="text-sm font-semibold text-slate-200">Resumo do evento</p>
      </div>
      <div className="space-y-2.5 p-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 text-slate-400">
              <row.icon size={13} className="text-slate-500" />
              {row.label}
            </span>
            <span className="font-medium text-slate-200">{row.value}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

const STEP_TIPS: Record<number, string> = {
  2: "Cada categoria pode ter benefícios e vagas próprias. Categorias inativas ficam ocultas do checkout, mas continuam preservando o histórico de quem já comprou.",
  3: "Um lote precisa de um limite de confirmadas, de uma data de encerramento, ou dos dois. Ative apenas um lote por vez para cada categoria.",
};

// Dica contextual por etapa: conteudo estatico e real (regras de negocio ja
// existentes), nunca um canal de suporte fabricado.
export function EventHelpCard({ step }: { step: number }) {
  const tip = STEP_TIPS[step] ?? "Siga a sequência de etapas para configurar o evento sem pular passos importantes.";

  return (
    <aside className="rounded-2xl border border-slate-800 bg-slate-950/60">
      <div className="border-b border-slate-800 px-4 py-3">
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200">
          <HelpCircle size={14} className="text-emerald-300" />
          Precisa de ajuda?
        </p>
      </div>
      <div className="p-4 text-xs leading-relaxed text-slate-400">{tip}</div>
    </aside>
  );
}
