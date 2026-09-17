import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminSection } from "@/components/admin";
import {
  ACCOUNT_HEALTH_STATE_LABEL,
  type AccountHealthAction,
  type AccountHealthListRow,
  type AccountHealthState,
} from "@/lib/account/account-health";
import { formatDateTimeBR } from "@/lib/utils/date";
import { loadAccountHealthCase } from "../actions";
import { AccountHealthCaseActions } from "../health-actions";

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, fallback = "—") {
  if (value == null || value === "") return fallback;
  return String(value);
}

export default async function AccountHealthCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const result = await loadAccountHealthCase(decodeURIComponent(caseId));
  if (!result.success) {
    return (
      <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
        <div className="mx-auto flex max-w-7xl gap-6">
          <Sidebar />
          <div className="min-w-0 flex-1"><p className="text-rose-200">{result.message}</p></div>
        </div>
      </main>
    );
  }
  if (!result.data?.found || !result.data.case) notFound();

  const row = result.data.case as AccountHealthListRow;
  const identity = asRecord(result.data.identity);
  const account = asRecord(result.data.account);
  const participation = Array.isArray(result.data.participation) ? result.data.participation : [];
  const tickets = Array.isArray(result.data.tickets) ? result.data.tickets : [];
  const state = row.state as AccountHealthState;
  const actions = (row.available_actions ?? []) as AccountHealthAction[];

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <TopBar
            title={row.display_name || "Caso de conta"}
            subtitle="Saúde de contas"
            breadcrumbs={[
              { label: "Início", href: "/painel" },
              { label: "Cadastros", href: "/cadastros" },
              { label: "Saúde de contas", href: "/cadastros/saude-contas" },
              { label: "Caso" },
            ]}
            backHref="/cadastros/saude-contas"
            fallbackHref="/cadastros/saude-contas"
          />

          <p className="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm text-slate-200">
            {ACCOUNT_HEALTH_STATE_LABEL[state]} · {result.data.diagnosis}
          </p>
          {row.participant_email_divergent || row.shared_email ? (
            <p className="text-sm text-slate-400">
              {row.participant_email_divergent ? "Há também e-mail divergente na participação." : null}
              {row.participant_email_divergent && row.shared_email ? " " : null}
              {row.shared_email ? "O e-mail deste cadastro também aparece em outra pessoa da organização." : null}
            </p>
          ) : null}

          <AccountHealthCaseActions caseId={row.case_id} state={state} actions={actions} canAct={result.canAct} />

          {actions.includes("open_contact") && row.registration_contact_id ? (
            <Link href={`/cadastros/${row.registration_contact_id}`} className="inline-flex min-h-11 items-center rounded-xl border border-slate-700 px-4 text-sm">
              Abrir cadastro
            </Link>
          ) : null}

          <AdminSection title="Identidade">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs text-slate-500">Cadastro</dt><dd>{text(identity?.full_name, row.display_name || "—")}</dd></div>
              <div><dt className="text-xs text-slate-500">CPF</dt><dd>{text(identity?.cpf)}</dd></div>
              <div><dt className="text-xs text-slate-500">E-mail</dt><dd>{text(identity?.email, row.display_email || "—")}</dd></div>
            </dl>
          </AdminSection>

          <AdminSection title="Conta">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs text-slate-500">Estado</dt><dd>{ACCOUNT_HEALTH_STATE_LABEL[state]}</dd></div>
              <div><dt className="text-xs text-slate-500">Conta confirmada?</dt><dd>{account?.confirmed === true ? "Sim" : account?.confirmed === false ? "Não" : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Criada em</dt><dd>{account?.created_at ? formatDateTimeBR(String(account.created_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Último login</dt><dd>{account?.last_sign_in_at ? formatDateTimeBR(String(account.last_sign_in_at)) : "Não disponível"}</dd></div>
            </dl>
          </AdminSection>

          <AdminSection title="Participação">
            {participation.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhuma participação nesta organização.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {participation.map((item) => (
                  <li key={String(item.participant_id)} className="rounded-xl border border-slate-800 px-3 py-2">
                    {item.event_name || "Evento"} {item.email ? `· ${item.email}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </AdminSection>

          <AdminSection title="Ingressos">
            <p className="mb-3 text-sm text-slate-400">{tickets.length} ingresso(s) nesta organização. O código do ingresso não é exibido aqui.</p>
            {tickets.length ? (
              <ul className="space-y-2 text-sm">
                {tickets.map((ticket) => (
                  <li key={String(ticket.ticket_id)} className="rounded-xl border border-slate-800 px-3 py-2">
                    Pedido {ticket.display_number || "—"} · {ticket.status || "—"} · {ticket.is_owner ? "Proprietário do ingresso" : "Sem propriedade materializada"}
                  </li>
                ))}
              </ul>
            ) : null}
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
