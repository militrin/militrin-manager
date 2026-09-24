import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminSection } from "@/components/admin";
import {
  ACCOUNT_HEALTH_STATE_LABEL,
  accountHealthAccountSituation,
  accountHealthProblemSummary,
  accountHealthProblemTitle,
  accountHealthTicketCopy,
  type AccountHealthAction,
  type AccountHealthIdentityConflict,
  type AccountHealthListRow,
  type AccountHealthResolution,
  type AccountHealthState,
  type AccountHealthTicket,
} from "@/lib/account/account-health";
import { publicOrderCode } from "@/lib/display-reference";
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

function asResolution(value: unknown): AccountHealthResolution | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    code: String(record.code ?? ""),
    reason_code: record.reason_code == null ? null : String(record.reason_code),
    status: String(record.status ?? ""),
    resolved_at: record.resolved_at == null ? null : String(record.resolved_at),
    resolved_by_name: record.resolved_by_name == null ? null : String(record.resolved_by_name),
    notes: record.notes == null ? null : String(record.notes),
  };
}

function asEmailCorrection(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  return {
    old_email: record.old_email == null ? null : String(record.old_email),
    new_email: record.new_email == null ? null : String(record.new_email),
    resolved_at: record.resolved_at == null ? null : String(record.resolved_at),
  };
}

function asConflict(value: unknown): AccountHealthIdentityConflict | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    cadastro_email: record.cadastro_email == null ? null : String(record.cadastro_email),
    linked_email: record.linked_email == null ? null : String(record.linked_email),
    linked_confirmed: typeof record.linked_confirmed === "boolean" ? record.linked_confirmed : null,
    linked_last_sign_in_at: record.linked_last_sign_in_at == null ? null : String(record.linked_last_sign_in_at),
    occupying_email: record.occupying_email == null ? null : String(record.occupying_email),
    occupying_confirmed: typeof record.occupying_confirmed === "boolean" ? record.occupying_confirmed : null,
    occupying_last_sign_in_at: record.occupying_last_sign_in_at == null ? null : String(record.occupying_last_sign_in_at),
    occupying_has_cadastro: typeof record.occupying_has_cadastro === "boolean" ? record.occupying_has_cadastro : null,
    message: record.message == null ? null : String(record.message),
  };
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
  const tickets = (Array.isArray(result.data.tickets) ? result.data.tickets : []) as AccountHealthTicket[];
  const state = row.state as AccountHealthState;
  const actions = (row.available_actions ?? []) as AccountHealthAction[];
  const resolution = asResolution(result.data.resolution ?? row.resolution);
  const identityConflict = asConflict(result.data.identity_conflict);
  const lastEmailCorrection = asEmailCorrection(result.data.last_email_correction);
  const sharedEmailAttention = state === "attention" && row.reason_code === "shared_email";
  const occupying = row.reason_code === "occupying_email_auth";
  const reviewed = state === "reviewed_without_account";

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

          <section className={`rounded-2xl border px-4 py-4 ${reviewed ? "border-emerald-700/40 bg-emerald-950/20" : occupying ? "border-amber-700/50 bg-amber-950/20" : "border-slate-800 bg-slate-900/70"}`}>
            <p className="text-xs uppercase tracking-wide text-slate-400">{accountHealthProblemTitle(row)}</p>
            <h2 className="mt-1 text-lg font-semibold">{accountHealthProblemSummary(row)}</h2>
            {reviewed && resolution ? (
              <dl className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-3">
                <div><dt className="text-xs text-slate-500">Revisado por</dt><dd>{resolution.resolved_by_name || "Administrador"}</dd></div>
                <div><dt className="text-xs text-slate-500">Data</dt><dd>{resolution.resolved_at ? formatDateTimeBR(resolution.resolved_at) : "—"}</dd></div>
                <div><dt className="text-xs text-slate-500">Motivo</dt><dd>E-mail compartilhado</dd></div>
              </dl>
            ) : null}
          </section>

          <AdminSection title="Cadastro">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs text-slate-500">Pessoa</dt><dd>{text(identity?.full_name, row.display_name || "—")}</dd></div>
              <div><dt className="text-xs text-slate-500">CPF</dt><dd>{text(identity?.cpf)}</dd></div>
              <div><dt className="text-xs text-slate-500">E-mail</dt><dd>{text(identity?.email, row.display_email || "—")}</dd></div>
            </dl>
          </AdminSection>

          <AdminSection title="Situação da conta">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs text-slate-500">Situação</dt><dd>{accountHealthAccountSituation(row)}</dd></div>
              <div><dt className="text-xs text-slate-500">Estado</dt><dd>{ACCOUNT_HEALTH_STATE_LABEL[state]}</dd></div>
              <div><dt className="text-xs text-slate-500">Conta confirmada?</dt><dd>{account?.confirmed === true ? "Sim" : account?.confirmed === false ? "Não" : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Criada em</dt><dd>{account?.created_at ? formatDateTimeBR(String(account.created_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Último login</dt><dd>{account?.last_sign_in_at ? formatDateTimeBR(String(account.last_sign_in_at)) : "Não disponível"}</dd></div>
            </dl>
          </AdminSection>

          {state === "no_account" && lastEmailCorrection ? (
            <section className="rounded-2xl border border-sky-700/40 bg-sky-950/20 px-4 py-4 text-sm text-sky-50">
              <p className="font-semibold">E-mail atualizado. Esta pessoa ainda não possui conta.</p>
              <p className="mt-1 text-sky-100/80">Nenhum convite foi enviado. Se quiser criar o acesso, use Enviar convite.</p>
            </section>
          ) : null}

          {sharedEmailAttention ? (
            <section className="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-4 text-sm text-slate-300">
              <h3 className="font-semibold text-slate-100">Por que apareceu aqui</h3>
              <p className="mt-1">O mesmo e-mail está sendo utilizado por outro Cadastro com conta ativa.</p>
              <p className="mt-2 text-slate-400">Isso não transfere ingresso e não une as pessoas. Cada CPF continua sendo uma pessoa distinta.</p>
            </section>
          ) : null}

          {occupying ? (
            <section className="rounded-2xl border border-amber-700/40 bg-amber-950/20 px-4 py-4 text-sm text-amber-100">
              <h3 className="font-semibold">Conflito de conta</h3>
              <p className="mt-1 text-amber-50/90">A correção exige revisar qual conta deve permanecer. Use Revisar identidade para ver o detalhe. Nesta versão não há correção automática.</p>
            </section>
          ) : null}

          {sharedEmailAttention || reviewed || occupying ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-200">
                {sharedEmailAttention ? "Como deseja resolver?" : occupying ? "O que pode fazer agora" : "Revisão"}
              </h3>
              {sharedEmailAttention ? (
                <ul className="space-y-1 text-sm text-slate-400">
                  <li>Manter sem conta: a pessoa continua no Militrin, sem acesso próprio. Ingressos não mudam.</li>
                  <li>Informar e-mail próprio: só atualiza o e-mail deste Cadastro. Nenhuma conta é criada agora.</li>
                </ul>
              ) : null}
              <AccountHealthCaseActions
                caseId={row.case_id}
                state={state}
                actions={actions}
                canAct={result.canAct}
                canResolve={result.canResolve}
                identityConflict={identityConflict}
              />
            </section>
          ) : (
            <AccountHealthCaseActions
              caseId={row.case_id}
              state={state}
              actions={actions}
              canAct={result.canAct}
              canResolve={result.canResolve}
              identityConflict={identityConflict}
            />
          )}

          {actions.includes("open_contact") && row.registration_contact_id ? (
            <Link href={`/cadastros/${row.registration_contact_id}`} className="inline-flex min-h-11 items-center rounded-xl border border-slate-700 px-4 text-sm">
              Abrir cadastro
            </Link>
          ) : null}

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
            <p className="mb-3 text-sm text-slate-400">{tickets.length} ingresso(s) nesta organização. O código do ingresso não é exibido aqui. Nada nesta tela define o dono da conta do ingresso.</p>
            {tickets.length ? (
              <ul className="space-y-2 text-sm">
                {tickets.map((ticket) => (
                  <li key={String(ticket.ticket_id)} className="rounded-xl border border-slate-800 px-3 py-2">
                    Pedido {publicOrderCode(ticket.display_number, ticket.display_number)} · {ticket.status || "—"} · {accountHealthTicketCopy(ticket)}
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
