import Link from "next/link";
import type { SharedEmailGroupView } from "@/lib/account/load-shared-email-group";

function inviteLabel(status: "linked" | "pending" | "none") {
  if (status === "linked") return "Conta ativa";
  if (status === "pending") return "Convite pendente";
  return "Sem convite";
}

export function SharedEmailAccountCard({
  group,
  contactId,
}: {
  group: SharedEmailGroupView;
  contactId: string;
}) {
  return (
    <section className="rounded-3xl border border-violet-500/30 bg-violet-500/5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-200">Conta compartilhada</p>
          <h2 className="mt-1 text-lg font-semibold text-violet-50">E-mail usado por {group.peopleCount} cadastros</h2>
          <p className="mt-1 text-sm text-slate-300">{group.email}</p>
        </div>
        <Link
          href={`/cadastros/${contactId}/conta-compartilhada`}
          className="rounded-xl bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950"
        >
          Gerenciar conta e ingressos
        </Link>
      </div>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["E-mail", group.email],
          ["Pessoas", String(group.peopleCount)],
          ["Ingressos", String(group.ticketCount)],
          ["Pessoa principal atual", group.currentPrincipalName ?? "Ainda não definida"],
          ["Status da conta", group.accountStatus === "active" ? "Conta ativa" : "Conta ainda não ativada"],
          ["Status do convite", group.inviteStatusLabel],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="mt-1 break-words text-slate-100">{value}</dd>
          </div>
        ))}
      </dl>
      {group.accountStatus === "pending_activation" ? (
        <p className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          Conta ainda não ativada. Ownership será concluído após o primeiro acesso.
        </p>
      ) : (
        <p className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
          Conta ativa. Os ingressos do grupo ficam visíveis para esta Pessoa em Minha Conta.
        </p>
      )}
      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-800">
        <div className="grid grid-cols-[minmax(0,1.4fr)_90px_90px_110px_120px] gap-2 bg-slate-950/70 px-3 py-2 text-xs uppercase tracking-wide text-slate-500">
          <span>Pessoa</span><span>PIN</span><span>Ingressos</span><span>Titular</span><span>Conta principal</span>
        </div>
        <div className="divide-y divide-slate-800">
          {group.people.map((person) => (
            <div key={person.id} className="grid grid-cols-[minmax(0,1.4fr)_90px_90px_110px_120px] gap-2 px-3 py-2.5 text-sm">
              <Link href={`/cadastros/${person.id}`} className="truncate font-medium text-slate-100 hover:text-violet-200">{person.name}</Link>
              <span className="font-mono text-xs text-slate-400">{person.pin ?? "—"}</span>
              <span>{person.ticketCount}</span>
              <span>{person.isHolder ? "Titular" : "—"}</span>
              <span className={person.isPrincipal ? "text-violet-200" : "text-slate-400"}>{person.isPrincipal ? "Sim" : "Não"}</span>
              <p className="col-span-5 text-xs text-slate-500">{inviteLabel(person.inviteStatus)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
