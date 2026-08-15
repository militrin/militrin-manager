"use client";

import Link from "next/link";
import { ParticipantIssuesDialog } from "@/app/inscricoes/participant-issues-dialog";
import { CopyableId } from "@/components/CopyableId";
import type { OperationParticipantDetails } from "../types";

export function ExpandedParticipantDetails({
  detail,
  busy,
  onResolved,
}: {
  detail: OperationParticipantDetails | undefined;
  busy: boolean;
  onResolved: (result: { ticketId: string | null; finalization: string | null; message: string }) => void | Promise<void>;
}) {
  if (busy && !detail) return <div className="text-sm text-slate-400">Carregando dados cadastrais...</div>;
  if (!detail) return <div className="text-sm text-rose-200">Não foi possível carregar os dados da inscrição.</div>;

  const isLegacy = detail.without_ticket_class === "legacy_unresolved";
  const isPendingImport = detail.without_ticket_class === "data_pending_import";

  return (
    <div className="grid gap-4">
      <div className={`rounded-2xl border p-4 ${isLegacy ? "border-amber-500/30 bg-amber-500/10" : "border-cyan-500/30 bg-cyan-500/10"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-current px-2.5 py-1 text-xs font-semibold">
            {isLegacy ? "Legado sem ingresso" : isPendingImport ? "Importação com dados pendentes" : "Sem ingresso emitido"}
          </span>
          <strong className="text-sm">Sem ingresso emitido</strong>
        </div>
        <p className="mt-2 text-sm">
          {isLegacy
            ? "Esta inscrição não possui vínculo comprovável com um ingresso."
            : isPendingImport
              ? "A origem da importação está comprovada. Conclua os dados pendentes para continuar a finalização original."
              : detail.no_ticket_reason}
        </p>
        <p className="mt-1 text-xs opacity-80">{detail.regularization_reason}</p>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Dados cadastrais</h3>
          <Link
            href={`/inscricoes/${detail.participant_id}/editar`}
            className="inline-flex h-8 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200 hover:border-slate-500"
          >
            Editar cadastro
          </Link>
        </div>
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><p className="text-slate-500">Participante</p><p>{detail.participant_name}</p></div>
          <div><p className="text-slate-500">CPF</p><p>{detail.cpf || "—"}</p></div>
          <div><p className="text-slate-500">Contato</p><p>{detail.phone || detail.participant_email || "—"}</p></div>
          <div><p className="text-slate-500">Categoria</p><p>{detail.category_name}</p></div>
          <div><p className="text-slate-500">Pagamento</p><p>{detail.payment_status} · {detail.payment_method}</p></div>
          <div><p className="text-slate-500">Origem</p><p>{detail.origin === "import" ? "Importação" : "Cadastro"}</p></div>
        </div>
        <div className="mt-3"><CopyableId label="PIN do cadastro" value={detail.registration_contact_pin} /></div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-sm font-semibold">Pendências e itens legados</h3>
        <div className="mt-3 space-y-2 text-sm">
          {detail.issues.length ? detail.issues.map((issue) => <p key={issue.id} className="rounded-lg border border-amber-500/25 p-2">{issue.message}</p>) : <p className="text-slate-400">Nenhuma pendência cadastral aberta.</p>}
          {detail.legacy_kit_items.map((item) => <p key={item.id} className="rounded-lg border border-slate-800 p-2">{item.item_name} · {item.status}{item.legacy_unresolved ? " · vínculo não resolvido" : ""}</p>)}
        </div>

        {!detail.can_regularize_ticket && detail.regularization_blockers.length > 0 ? (
          <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
            <p className="text-xs font-semibold text-amber-200">O que falta pra regularizar o ingresso:</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-amber-100">
              {detail.regularization_blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {detail.issues.length > 0 ? (
            <ParticipantIssuesDialog
              participantId={detail.participant_id}
              participantName={detail.participant_name}
              issues={detail.issues}
              canEdit
              shirtOptions={detail.shirt_options}
              triggerLabel="Revisar pendências"
              onResolved={onResolved}
            />
          ) : null}
          {detail.can_issue_ticket ? (
            <Link
              href={detail.registration_contact_pin ? `/ingressos/emitir?pin=${detail.registration_contact_pin}` : "/ingressos/emitir"}
              className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200"
            >
              Emitir ingresso
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
