"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, X } from "lucide-react";
import {
  countUnreadOrganizationNotificationsAction,
  listOrganizationNotificationsAction,
  markAllOrganizationNotificationsReadAction,
  markOrganizationNotificationReadAction,
} from "@/app/notificacoes/actions";
import { formatRelativeTimePt } from "@/lib/notifications/relative-time";
import type { OrganizationNotificationRow } from "@/lib/notifications/types";
import { createClient } from "@/lib/supabase/client";

export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<OrganizationNotificationRow[]>([]);
  const [isPending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const [countResult, listResult] = await Promise.all([
      countUnreadOrganizationNotificationsAction(),
      listOrganizationNotificationsAction({ readState: "all", limit: 10, offset: 0 }),
    ]);
    if (countResult.success) setUnreadCount(countResult.count);
    if (listResult.success) setItems(listResult.notifications);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("organization-notifications")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "organization_notifications" }, () => {
        void refresh();
      })
      .subscribe();

    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    function handlePointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  function openNotification(item: OrganizationNotificationRow) {
    startTransition(async () => {
      if (item.isUnread) {
        setItems((prev) => prev.map((row) => (row.notificationId === item.notificationId ? { ...row, isUnread: false, readAt: new Date().toISOString() } : row)));
        setUnreadCount((prev) => Math.max(0, prev - 1));
        await markOrganizationNotificationReadAction(item.notificationId);
      }
      setOpen(false);
      router.push(item.actionHref);
    });
  }

  function markAllRead() {
    if (unreadCount === 0) return;
    startTransition(async () => {
      setItems((prev) => prev.map((row) => ({ ...row, isUnread: false, readAt: row.readAt ?? new Date().toISOString() })));
      setUnreadCount(0);
      await markAllOrganizationNotificationsReadAction();
    });
  }

  const badgeLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notificações, ${unreadCount} não lidas` : "Notificações"}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={`relative rounded-2xl border border-slate-800 text-slate-300 transition hover:bg-slate-800 ${compact ? "flex h-10 w-10 items-center justify-center" : "p-2.5"}`}
      >
        <Bell size={compact ? 18 : 18} />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold leading-4 text-emerald-950">
            {badgeLabel}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40 bg-slate-950/70 sm:hidden" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Notificações"
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-3xl border border-slate-800 bg-slate-950 shadow-2xl sm:absolute sm:inset-auto sm:right-0 sm:top-12 sm:bottom-auto sm:z-30 sm:w-96 sm:max-h-[min(28rem,70vh)] sm:rounded-2xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <p className="text-sm font-semibold text-slate-100">Notificações</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={isPending || unreadCount === 0}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-emerald-200 disabled:opacity-40"
                >
                  <CheckCheck size={14} />
                  Marcar todas como lidas
                </button>
                <button type="button" aria-label="Fechar" onClick={() => setOpen(false)} className="rounded-lg border border-slate-800 p-1 text-slate-300 sm:hidden">
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-slate-400">Nenhuma notificação por enquanto.</p>
              ) : (
                <ul>
                  {items.map((item) => (
                    <li key={item.notificationId} className="border-b border-slate-800/80 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => openNotification(item)}
                        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-900/80"
                      >
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.isUnread ? "bg-emerald-400" : "bg-transparent"}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-slate-100">{item.title}</span>
                          <span className="mt-0.5 block text-xs text-slate-400">{item.body}</span>
                          <span className="mt-1 block text-[11px] text-slate-500">{formatRelativeTimePt(item.createdAt, now)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-slate-800 px-4 py-3">
              <Link
                href="/notificacoes"
                onClick={() => setOpen(false)}
                className="block text-center text-sm font-medium text-emerald-300 hover:text-emerald-200"
              >
                Ver todas as notificações
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
