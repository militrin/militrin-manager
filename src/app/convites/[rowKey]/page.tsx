import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminActivityTimeline, AdminSection } from "@/components/admin";
import { getCurrentPermissionMap } from "@/lib/admin/permissions";
import { sharedEmailBadgeLabel } from "@/lib/account/shared-email-ownership";
import {
  INVITE_CENTER_PERMISSIONS,
  INVITE_CENTER_STATUS_LABEL,
  canResendInviteCenter,
  compactInviteCenterMaskedEmail,
  inviteCenterAdminActionReason,
  inviteCenterFirstAccessLabel,
  inviteCenterResendLabel,
  type InviteCenterStatus,
} from "@/lib/invites/invite-center-status";
import { formatDateTimeBR } from "@/lib/utils/date";
import { loadInviteCenterDetail } from "../actions";
import { InviteCenterResendButton } from "../invite-center-resend";
import type { InviteCenterListRow, InviteCenterPerson } from "@/lib/invites/invite-center-types";

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export default async function InviteCenterDetailPage({ params }: { params: Promise<{ rowKey: string }> }) {
  const { rowKey } = await params;
  const permissionMap = await getCurrentPermissionMap([...INVITE_CENTER_PERMISSIONS]);
  const result = await loadInviteCenterDetail(rowKey);
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
  const payload = asRecord(result.data);
  if (!payload?.found) notFound();

  const summary = asRecord(payload.summary) as InviteCenterListRow | null;
  const invite = asRecord(payload.invite);
  const profile = asRecord(payload.profile);
  const people = (Array.isArray(payload.people) ? payload.people : []) as InviteCenterPerson[];
  const tickets = Array.isArray(payload.tickets) ? payload.tickets as Array<Record<string, unknown>> : [];
  const timeline = Array.isArray(payload.timeline) ? payload.timeline as Array<{ at?: string; title?: string; description?: string }> : [];
  const status = (summary?.status ?? "nao_enviado") as InviteCenterStatus;
  const principal = people.find((person) => person.is_principal) ?? people[0];
  const ticketCount = Number(summary?.ticket_count ?? tickets.length);
  const canResend = permissionMap["invites.resend"] && canResendInviteCenter(status);
  const linkedTickets = tickets.filter((ticket) => ticket.owner_materialized).length;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <TopBar
            title={String(summary?.principal_name ?? principal?.full_name ?? "Convite")}
            subtitle="Central de Convites"
            breadcrumbs={[{ label: "Início", href: "/painel" }, { label: "Convites", href: "/convites" }, { label: "Detalhe" }]}
            backHref="/convites"
            fallbackHref="/convites"
          />

          {status === "concluido" ? (
            <p className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
              CONCLUÍDO ✓ {summary?.claimed_at ? formatDateTimeBR(summary.claimed_at) : ""} {ticketCount ? `· ${ticketCount} ingressos vinculados` : ""}
            </p>
          ) : null}
          {status === "admin_action" ? (
            <p className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              AÇÃO NECESSÁRIA · {inviteCenterAdminActionReason(Boolean(summary?.mixed_intended_owners))}
            </p>
          ) : null}
          {status === "pendente" ? (
            <p className="rounded-2xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-300">
              Convite enviado. O link de acesso vale por 24 horas após o envio. Ainda não iniciou o primeiro acesso.
            </p>
          ) : null}
          {status === "expirado" ? (
            <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Link de acesso expirado. A janela Auth de 24 horas terminou. Reenvie para gerar um novo link.
            </p>
          ) : null}
          {status === "cadastro_pendente" ? (
            <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Cadastro incompleto. A conta Auth já confirmou o e-mail, mas o fluxo obrigatório ainda não terminou.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {principal?.contact_id ? <Link href={`/cadastros/${principal.contact_id}`} className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-sm">Abrir cadastro</Link> : null}
            {tickets[0]?.id ? <Link href={`/ingressos/${String(tickets[0].id)}`} className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-sm">Abrir ingressos</Link> : null}
            {summary?.import_batch_id ? <Link href={`/importacoes?batchId=${encodeURIComponent(String(summary.import_batch_id))}`} className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-sm">Abrir lote</Link> : null}
            {status === "admin_action" && principal?.contact_id ? (
              <Link href={`/cadastros/${principal.contact_id}/conta-compartilhada`} className="inline-flex h-10 items-center rounded-xl border border-amber-400/40 px-4 text-sm text-amber-100">Gerenciar</Link>
            ) : null}
            {canResend && principal?.contact_id ? (
              <InviteCenterResendButton
                contactId={principal.contact_id}
                emailMasked={String(payload.email_masked ?? summary?.email_masked ?? "")}
                principalName={String(summary?.principal_name ?? principal.full_name)}
                lastSentAt={summary?.sent_at ?? summary?.invite_created_at ?? null}
                statusLabel={INVITE_CENTER_STATUS_LABEL[status]}
                ticketCount={ticketCount}
                actionLabel={inviteCenterResendLabel(status)}
              />
            ) : null}
          </div>

          <AdminSection title="Conta">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
              <div><dt className="text-xs text-slate-500">Pessoa principal</dt><dd>{summary?.principal_name ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">PIN</dt><dd>{summary?.principal_pin ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">E-mail</dt><dd>{compactInviteCenterMaskedEmail(String(payload.email_masked ?? summary?.email_masked ?? "—"))}</dd></div>
              <div><dt className="text-xs text-slate-500">Auth vinculado?</dt><dd>{summary?.auth_linked ? "Sim" : "Não"}</dd></div>
              <div><dt className="text-xs text-slate-500">Account status</dt><dd>{String(profile?.account_status ?? "—")}</dd></div>
              <div><dt className="text-xs text-slate-500">Profile completo?</dt><dd>{profile?.must_complete_profile ? "Não" : profile ? "Sim" : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Primeiro acesso</dt><dd>{inviteCenterFirstAccessLabel(status, Boolean(summary?.cadastral_incomplete))}</dd></div>
              <div><dt className="text-xs text-slate-500">Ativação</dt><dd>{profile?.activation_completed_at ? formatDateTimeBR(String(profile.activation_completed_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Último login</dt><dd>{profile?.last_sign_in_at ? formatDateTimeBR(String(profile.last_sign_in_at)) : "Não disponível"}</dd></div>
            </dl>
          </AdminSection>

          <AdminSection title="Convite">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
              <div><dt className="text-xs text-slate-500">Status</dt><dd>{INVITE_CENTER_STATUS_LABEL[status]}</dd></div>
              <div><dt className="text-xs text-slate-500">Enviado em</dt><dd>{invite?.auth_email_sent_at ? formatDateTimeBR(String(invite.auth_email_sent_at)) : invite?.created_at ? formatDateTimeBR(String(invite.created_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Link válido até</dt><dd>{invite?.auth_link_expires_at ? formatDateTimeBR(String(invite.auth_link_expires_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Registro interno até</dt><dd>{invite?.expires_at ? formatDateTimeBR(String(invite.expires_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Auth confirmado em</dt><dd>{invite?.auth_confirmed_at ? formatDateTimeBR(String(invite.auth_confirmed_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">claimed_at</dt><dd>{invite?.claimed_at ? formatDateTimeBR(String(invite.claimed_at)) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Tentativas</dt><dd>{String(invite?.attempt_count ?? 0)}</dd></div>
              <div><dt className="text-xs text-slate-500">Último erro</dt><dd>{String(invite?.last_error_safe ?? "—")}</dd></div>
              <div><dt className="text-xs text-slate-500">Job</dt><dd>{invite?.job_id ? String(invite.job_id) : "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Lote</dt><dd>{invite?.import_batch_id ? String(invite.import_batch_id) : "—"}</dd></div>
            </dl>
          </AdminSection>

          <AdminSection title="Pessoas cobertas" description={people.length > 1 ? sharedEmailBadgeLabel(people.length) : "Uma pessoa neste e-mail. Pessoas não são mescladas."}>
            <ul className="space-y-2 text-sm">
              {people.map((person) => (
                <li key={person.contact_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 px-3 py-2">
                  <span>{person.full_name} — {person.is_principal ? "principal" : "titular"}</span>
                  <Link href={`/cadastros/${person.contact_id}`} className="text-xs text-emerald-300">Abrir cadastro</Link>
                </li>
              ))}
            </ul>
          </AdminSection>

          <AdminSection title="Ingressos" description={`${linkedTickets} com owner materializado. Holder e owner permanecem distintos. Kit/check-in apenas informativo.`}>
            <div className="space-y-2 text-sm">
              {tickets.map((ticket) => (
                <div key={String(ticket.id)} className="rounded-xl border border-slate-800 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p>{String(ticket.event_name ?? "Evento")} · {String(ticket.status ?? "—")}</p>
                    <Link href={`/ingressos/${String(ticket.id)}`} className="text-xs text-emerald-300">Abrir ingresso</Link>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">Holder: {String(ticket.holder_name ?? "—")}</p>
                  <p className="text-xs text-slate-400">Intended owner: {String(ticket.intended_owner_name ?? "—")}</p>
                  <p className="text-xs text-slate-400">owner_user_id: {ticket.owner_materialized ? "materializado" : "não"}</p>
                  {ticket.shirt ? <p className="text-xs text-slate-400">Camiseta: {String(ticket.shirt)}</p> : null}
                  <p className="text-xs text-slate-500">Kit entregue: {ticket.kit_delivered ? "sim" : "não"}{ticket.used_at ? ` · check-in ${formatDateTimeBR(String(ticket.used_at))}` : ""}</p>
                </div>
              ))}
              {!tickets.length ? <p className="text-slate-400">Nenhum ingresso vinculado a este grupo.</p> : null}
            </div>
          </AdminSection>

          <AdminSection title="Histórico" description="Somente eventos que o sistema consegue provar. Sem telemetria de 'link aberto'.">
            {timeline.length ? (
              <AdminActivityTimeline
                items={timeline.map((item, index) => ({
                  id: `${item.at ?? "event"}-${index}`,
                  title: String(item.title ?? "Evento"),
                  description: item.description ? String(item.description) : undefined,
                  date: item.at ? formatDateTimeBR(item.at) : undefined,
                }))}
              />
            ) : (
              <p className="text-sm text-slate-400">Ainda não há eventos comprováveis neste convite.</p>
            )}
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
