"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { markAllOrganizationNotificationsReadAction, markOrganizationNotificationReadAction } from "./actions";
import { formatRelativeTimePt } from "@/lib/notifications/relative-time";
import { notificationTypeLabel, type OrganizationNotificationRow } from "@/lib/notifications/types";

function hrefFor(readState: string, typeFilter: string, page: number) {
  const params = new URLSearchParams();
  if (readState === "unread") params.set("filtro", "nao-lidas");
  if (readState === "read") params.set("filtro", "lidas");
  if (typeFilter === "solicitacoes" || typeFilter === "feedbacks") params.set("tipo", typeFilter);
  if (page > 1) params.set("pagina", String(page));
  const query = params.toString();
  return query ? `/notificacoes?${query}` : "/notificacoes";
}

export function NotificationsInbox({
  notifications,
  totalCount,
  readState,
  typeFilter,
  page,
  pageSize,
  errorMessage,
}: {
  notifications: OrganizationNotificationRow[];
  totalCount: number;
  readState: "all" | "unread" | "read";
  typeFilter: string;
  page: number;
  pageSize: number;
  errorMessage: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  function openItem(item: OrganizationNotificationRow) {
    startTransition(async () => {
      if (item.isUnread) await markOrganizationNotificationReadAction(item.notificationId);
      router.push(item.actionHref);
    });
  }

  function markAll() {
    startTransition(async () => {
      await markAllOrganizationNotificationsReadAction();
      router.refresh();
    });
  }

  return (
    <section className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {[
            { id: "all", label: "Todas", href: hrefFor("all", typeFilter, 1) },
            { id: "unread", label: "Não lidas", href: hrefFor("unread", typeFilter, 1) },
            { id: "read", label: "Lidas", href: hrefFor("read", typeFilter, 1) },
          ].map((filter) => (
            <Link
              key={filter.id}
              href={filter.href}
              className={`rounded-full border px-3 py-1.5 text-xs ${readState === filter.id ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200" : "border-slate-800 text-slate-300"}`}
            >
              {filter.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { id: "todas", label: "Todos os tipos", href: hrefFor(readState, "todas", 1) },
            { id: "solicitacoes", label: "Solicitações", href: hrefFor(readState, "solicitacoes", 1) },
            { id: "feedbacks", label: "Feedbacks", href: hrefFor(readState, "feedbacks", 1) },
          ].map((filter) => (
            <Link
              key={filter.id}
              href={filter.href}
              className={`rounded-full border px-3 py-1.5 text-xs ${typeFilter === filter.id ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200" : "border-slate-800 text-slate-300"}`}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button type="button" onClick={markAll} disabled={isPending} className="text-xs text-emerald-300 disabled:opacity-40">
          Marcar todas como lidas
        </button>
      </div>

      {errorMessage ? <p className="mt-4 text-sm text-rose-300">{errorMessage}</p> : null}

      {notifications.length === 0 && !errorMessage ? (
        <p className="mt-8 text-center text-sm text-slate-400">Nenhuma notificação neste filtro.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-800">
          {notifications.map((item) => (
            <li key={item.notificationId}>
              <button type="button" onClick={() => openItem(item)} className="flex w-full items-start gap-3 py-4 text-left hover:bg-slate-950/40">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.isUnread ? "bg-emerald-400" : "bg-slate-700"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">{item.title}</span>
                    <span className="rounded-full border border-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                      {notificationTypeLabel(item.type)}
                    </span>
                  </span>
                  <span className="mt-1 block text-sm text-slate-400">{item.body}</span>
                  <span className="mt-1 block text-xs text-slate-500">{formatRelativeTimePt(item.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
          <span>Página {page} de {totalPages}</span>
          <div className="flex gap-2">
            {page > 1 ? <Link href={hrefFor(readState, typeFilter, page - 1)} className="rounded-lg border border-slate-800 px-3 py-1.5 text-slate-200">Anterior</Link> : null}
            {page < totalPages ? <Link href={hrefFor(readState, typeFilter, page + 1)} className="rounded-lg border border-slate-800 px-3 py-1.5 text-slate-200">Próxima</Link> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
