"use client";

import Link from "next/link";
import { InstagramConnectionCard } from "@/components/sorteios/InstagramConnectionCard";
import { AdminEmptyState } from "@/components/admin";
import type { GiveawayListItem } from "@/app/sorteios/giveaway-actions";
import type { InstagramIntegrationStatus } from "@/app/sorteios/instagram-actions";
import { formatInstagramHandle } from "./types";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("pt-BR");
}

function GiveawayCard({ item }: { item: GiveawayListItem }) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white">{item.name}</h3>
          <p className="mt-1 text-xs text-slate-400">{item.publicId}</p>
        </div>
        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-200">{item.statusLabel}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-300 sm:grid-cols-4">
        <div><dt className="text-slate-500">Fonte</dt><dd>{item.source === "instagram" ? "Instagram" : "CSV"}</dd></div>
        <div><dt className="text-slate-500">Criado em</dt><dd>{formatDate(item.createdAt)}</dd></div>
        <div><dt className="text-slate-500">Comentários</dt><dd>{item.comments}</dd></div>
        <div><dt className="text-slate-500">Participantes</dt><dd>{item.uniqueParticipants}</dd></div>
        <div><dt className="text-slate-500">Chances</dt><dd>{item.chances}</dd></div>
        <div className="col-span-2 sm:col-span-3">
          <dt className="text-slate-500">Publicação</dt>
          <dd className="truncate">{item.permalink || "Não vinculada"}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-slate-500">Vencedor</dt>
          <dd>{item.winnerUsername ? `@${item.winnerUsername}${item.winnerConfirmed ? " (confirmado)" : " (não confirmado)"}` : "—"}</dd>
        </div>
      </dl>
      <Link href={`/sorteios/${item.id}`} className="mt-4 inline-flex rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300">
        ABRIR SORTEIO
      </Link>
    </article>
  );
}

function Section({ title, items }: { title: string; items: GiveawayListItem[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-400">{title}</h2>
      {items.length ? items.map((item) => <GiveawayCard key={item.id} item={item} />) : (
        <p className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm text-slate-400">Nenhum sorteio nesta seção.</p>
      )}
    </section>
  );
}

export function GiveawayHub({
  items,
  instagramStatus,
}: {
  items: GiveawayListItem[];
  instagramStatus: InstagramIntegrationStatus;
}) {
  const inProgress = items.filter((item) => item.section === "in_progress");
  const drafts = items.filter((item) => item.section === "drafts");
  const finished = items.filter((item) => item.section === "finished");
  const handle = formatInstagramHandle(instagramStatus.username);

  return (
    <div className="space-y-4">
      <InstagramConnectionCard initialStatus={instagramStatus} />
      {handle ? <p className="text-xs text-slate-400">Conta conectada: {handle}</p> : null}
      <div className="flex justify-end">
        <Link href="/sorteios/novo" className="rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-300">
          NOVO SORTEIO
        </Link>
      </div>
      {items.length === 0 ? (
        <AdminEmptyState
          title="Nenhum sorteio ainda"
          description="Crie um rascunho, escolha Instagram ou CSV, e conduza o sorteio sem alterar os anteriores."
          action={<Link href="/sorteios/novo" className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950">NOVO SORTEIO</Link>}
        />
      ) : (
        <div className="space-y-6">
          <Section title="Em andamento" items={inProgress} />
          <Section title="Rascunhos" items={drafts} />
          <Section title="Finalizados" items={finished} />
        </div>
      )}
    </div>
  );
}
