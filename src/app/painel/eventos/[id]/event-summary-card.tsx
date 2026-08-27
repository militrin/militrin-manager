"use client";

import { useState } from "react";
import Link from "next/link";
import { Calendar, MapPin, PencilLine, Users } from "lucide-react";
import { MilitrinEventArtwork } from "@/components/militrin";
import { formatDateBR } from "@/lib/utils/date";

export type EventSummaryCardData = {
  id: string;
  name: string;
  year: number | null;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  is_active: boolean;
  registration_enabled: boolean;
  banner_card_url: string | null;
  banner_hero_url: string | null;
  participants_count: number | null;
};

// O banner (card e hero) pertence ao EVENTO, nunca a uma categoria: este e o
// unico lugar da administracao que usa banner_card_url/banner_hero_url como
// imagem visual. Categorias mostram apenas estrutura comercial (nome, status,
// beneficios, contagens) — ver src/app/categorias/ui.tsx.
export function EventSummaryCard({ event }: { event: EventSummaryCardData }) {
  const [expanded, setExpanded] = useState(false);
  const bannerUrl = event.banner_card_url || event.banner_hero_url;
  const hasDescription = Boolean(event.description?.trim());

  return (
    <div className="overflow-hidden rounded-3xl border border-slate-800/80 bg-slate-950/60 shadow-lg shadow-black/10">
      <div className="flex flex-col sm:flex-row">
        <MilitrinEventArtwork src={bannerUrl} className="shrink-0 sm:w-[34%]" />

        <div className="min-w-0 flex-1 p-6 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-2xl font-semibold text-slate-100">
                {event.name}
                {event.year ? ` (${event.year})` : ""}
              </p>

              <div className="mt-2 flex flex-wrap gap-2">
                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${event.is_active ? "border-amber-500/40 text-amber-300" : "border-slate-700 text-slate-400"}`}>
                  {event.is_active ? "Evento ativo" : "Inativo"}
                </span>
                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${event.registration_enabled ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>
                  {event.registration_enabled ? "Vendas abertas" : "Vendas fechadas"}
                </span>
              </div>
            </div>
            <Link
              href={`/painel/eventos/${event.id}?etapa=1`}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"
            >
              <PencilLine size={14} />
              Editar evento
            </Link>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <Calendar size={14} className="text-slate-500" />
              {event.starts_at ? formatDateBR(event.starts_at) : "Data a definir"}
            </span>
            {event.location ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={14} className="text-slate-500" />
                {event.location}
              </span>
            ) : null}
            {event.participants_count !== null ? (
              <span className="inline-flex items-center gap-1.5">
                <Users size={14} className="text-slate-500" />
                {event.participants_count} inscritos
              </span>
            ) : null}
          </div>

          {hasDescription ? (
            <div className="mt-4">
              <p className={`text-sm text-slate-300 ${expanded ? "" : "line-clamp-2"}`}>{event.description}</p>
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="mt-1 text-xs font-medium text-emerald-300"
              >
                {expanded ? "Ver menos" : "Ver mais"}
              </button>
            </div>
          ) : null}

          {expanded ? (
            <div className="mt-4 grid gap-1.5 border-t border-slate-800 pt-4 text-xs text-slate-400 sm:grid-cols-2">
              <p><strong className="text-slate-300">Início:</strong> {event.starts_at ? formatDateBR(event.starts_at) : "-"}</p>
              <p><strong className="text-slate-300">Fim:</strong> {event.ends_at ? formatDateBR(event.ends_at) : "-"}</p>
              <p><strong className="text-slate-300">Local:</strong> {event.location || "-"}</p>
              <p><strong className="text-slate-300">Inscritos:</strong> {event.participants_count ?? "-"}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
