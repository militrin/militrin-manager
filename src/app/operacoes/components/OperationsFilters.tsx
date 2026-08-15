"use client";

import { useMemo, useState } from "react";
import type { PickupEvent, PickupFilters } from "../types";

type OperationsFiltersProps = {
  filters: PickupFilters;
  events: PickupEvent[];
  selectedEvent: PickupEvent | null;
  shirtTypes: string[];
  shirtSizes: string[];
  categories: string[];
  cities: string[];
  loading: boolean;
  summary: {
    totalGroups: number;
    totalTickets: number;
    pending: number;
    completed: number;
  };
  onEventChange: (eventId: string) => void;
  onFilterChange: <K extends keyof PickupFilters>(key: K, value: PickupFilters[K]) => void;
  onClearAllFilters: () => void;
  onOpenScanner: () => void;
};

type ActiveChip = {
  key: keyof PickupFilters;
  label: string;
};

export function OperationsFilters({
  filters,
  events,
  selectedEvent,
  shirtTypes,
  shirtSizes,
  categories,
  cities,
  loading,
  summary,
  onEventChange,
  onFilterChange,
  onClearAllFilters,
  onOpenScanner,
}: OperationsFiltersProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selectClass = "h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-200";

  const activeChips = useMemo<ActiveChip[]>(() => {
    const chips: ActiveChip[] = [];

    if (filters.category !== "all") chips.push({ key: "category", label: `Categoria: ${filters.category}` });
    if (filters.city !== "all") chips.push({ key: "city", label: `Cidade: ${filters.city}` });

    if (filters.gender !== "all") {
      const genderLabel =
        filters.gender === "male"
          ? "Masculino"
          : filters.gender === "female"
            ? "Feminino"
            : "Não informado";
      chips.push({ key: "gender", label: `Gênero: ${genderLabel}` });
    }

    if (filters.ageGroup !== "all") {
      const ageLabel =
        filters.ageGroup === "lt18"
          ? "Até 17"
          : filters.ageGroup === "18to29"
            ? "18 a 29"
            : filters.ageGroup === "30to39"
              ? "30 a 39"
              : filters.ageGroup === "40to49"
                ? "40 a 49"
                : "50+";
      chips.push({ key: "ageGroup", label: `Faixa etária: ${ageLabel}` });
    }

    if (filters.paymentStatus !== "all") {
      chips.push({
        key: "paymentStatus",
        label: `Pagamento: ${filters.paymentStatus === "paid" ? "Confirmado" : "Pendente"}`,
      });
    }

    if (filters.kitStatus !== "all") {
      const kitLabel =
        filters.kitStatus === "pending"
          ? "Pendente"
          : filters.kitStatus === "partial"
            ? "Parcial"
            : filters.kitStatus === "delivered"
              ? "Entregue"
              : "Não se aplica";
      chips.push({ key: "kitStatus", label: `Kit: ${kitLabel}` });
    }

    if (filters.checkinStatus !== "all") {
      chips.push({
        key: "checkinStatus",
        label: `Check-in: ${filters.checkinStatus === "done" ? "Realizado" : "Pendente"}`,
      });
    }

    if (filters.wristbandStatus !== "all") {
      chips.push({
        key: "wristbandStatus",
        label: `Pulseira: ${filters.wristbandStatus === "active" ? "Vinculada" : "Sem pulseira"}`,
      });
    }

    if (filters.shirtType !== "all") chips.push({ key: "shirtType", label: `Camiseta: ${filters.shirtType}` });
    if (filters.shirtSize !== "all") chips.push({ key: "shirtSize", label: `Tamanho: ${filters.shirtSize}` });
    if (filters.onlyPending) chips.push({ key: "onlyPending", label: "Somente pendências" });

    return chips;
  }, [filters]);

  function clearSingleFilter(key: keyof PickupFilters) {
    if (key === "onlyPending") {
      onFilterChange("onlyPending", false);
      return;
    }

    if (key === "category") onFilterChange("category", "all");
    if (key === "city") onFilterChange("city", "all");
    if (key === "gender") onFilterChange("gender", "all");
    if (key === "ageGroup") onFilterChange("ageGroup", "all");
    if (key === "paymentStatus") onFilterChange("paymentStatus", "all");
    if (key === "kitStatus") onFilterChange("kitStatus", "all");
    if (key === "checkinStatus") onFilterChange("checkinStatus", "all");
    if (key === "wristbandStatus") onFilterChange("wristbandStatus", "all");
    if (key === "shirtType") onFilterChange("shirtType", "all");
    if (key === "shirtSize") onFilterChange("shirtSize", "all");
  }

  return (
    <>
      <div className="space-y-2">
        <div className="grid gap-2 lg:max-w-90">
          <select
            value={filters.eventId}
            onChange={(event) => onEventChange(event.target.value)}
            className={selectClass}
          >
            {events.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.is_active ? " — ativo" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2 lg:grid-cols-[minmax(360px,1fr)_auto_auto]">
          <input
            value={filters.search}
            onChange={(event) => onFilterChange("search", event.target.value)}
            placeholder="Nome, CPF, telefone, QR ou pulseira..."
            className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs"
          />

          <button
            type="button"
            onClick={onOpenScanner}
            className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-cyan-950"
          >
            Escanear QR
          </button>

          <button
            type="button"
            disabled
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-500"
          >
            Modo Turbo (Em breve)
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setAdvancedOpen((current) => !current)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs"
          >
            Filtros avançados
            <span className="text-slate-400">{advancedOpen ? "▲" : "▼"}</span>
          </button>

          <div className="text-xs text-slate-400">
            {summary.totalGroups} compras/inscrições exibidas • {summary.totalTickets} ingressos totais • {summary.pending} pendentes • {summary.completed} concluídos
          </div>
        </div>
      </div>

      {advancedOpen ? (
        <div className="mt-2 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <div className="grid gap-2 lg:grid-cols-[repeat(5,minmax(120px,1fr))]">
            <select
              value={filters.category}
              onChange={(event) => onFilterChange("category", event.target.value)}
              className={selectClass}
            >
              <option value="all">Categoria: todas</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>

            <select
              value={filters.city}
              onChange={(event) => onFilterChange("city", event.target.value)}
              className={selectClass}
            >
              <option value="all">Cidade: todas</option>
              {cities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
            </select>

            <select
              value={filters.gender}
              onChange={(event) => onFilterChange("gender", event.target.value)}
              className={selectClass}
            >
              <option value="all">Todos os gêneros</option>
              <option value="male">Masculino</option>
              <option value="female">Feminino</option>
              <option value="not_informed">Não informado</option>
            </select>

            <select
              value={filters.ageGroup}
              onChange={(event) => onFilterChange("ageGroup", event.target.value)}
              className={selectClass}
            >
              <option value="all">Faixa etária: todas</option>
              <option value="lt18">Até 17</option>
              <option value="18to29">18 a 29</option>
              <option value="30to39">30 a 39</option>
              <option value="40to49">40 a 49</option>
              <option value="50plus">50+</option>
            </select>

            <select
              value={filters.paymentStatus}
              onChange={(event) => onFilterChange("paymentStatus", event.target.value)}
              className={selectClass}
            >
              <option value="all">Pagamento: todos</option>
              <option value="paid">Confirmado</option>
              <option value="pending">Pendente</option>
            </select>

            <select
              value={filters.kitStatus}
              onChange={(event) => onFilterChange("kitStatus", event.target.value)}
              className={selectClass}
            >
              <option value="all">Kit: todos</option>
              <option value="pending">Pendente</option>
              <option value="partial">Parcial</option>
              <option value="delivered">Entregue</option>
              <option value="none">Não se aplica</option>
              <option value="configuration_pending">Configuração pendente</option>
              <option value="error">Erro ao consultar</option>
            </select>

            <select
              value={filters.checkinStatus}
              onChange={(event) => onFilterChange("checkinStatus", event.target.value)}
              className={selectClass}
            >
              <option value="all">Check-in: todos</option>
              <option value="pending">Pendente</option>
              <option value="done">Realizado</option>
            </select>

            {selectedEvent?.wristband_enabled ? (
              <select
                value={filters.wristbandStatus}
                onChange={(event) => onFilterChange("wristbandStatus", event.target.value)}
                className={selectClass}
              >
                <option value="all">Pulseira: todas</option>
                <option value="active">Vinculada</option>
                <option value="pending">Sem pulseira</option>
              </select>
            ) : null}

            {selectedEvent?.has_shirt ? (
              <>
                <select
                  value={filters.shirtType}
                  onChange={(event) => onFilterChange("shirtType", event.target.value)}
                  className={selectClass}
                >
                  <option value="all">Todas as camisetas</option>
                  {shirtTypes.map((shirtType) => (
                    <option key={shirtType} value={shirtType}>
                      {shirtType}
                    </option>
                  ))}
                </select>

                <select
                  value={filters.shirtSize}
                  onChange={(event) => onFilterChange("shirtSize", event.target.value)}
                  className={selectClass}
                >
                  <option value="all">Todos os tamanhos</option>
                  {shirtSizes.map((shirtSize) => (
                    <option key={shirtSize} value={shirtSize}>
                      {shirtSize}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-200">
              <input
                type="checkbox"
                checked={filters.onlyPending}
                onChange={(event) => onFilterChange("onlyPending", event.target.checked)}
                className="h-4 w-4"
              />
              Somente pendências
            </label>
          </div>
        </div>
      ) : activeChips.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {activeChips.map((chip) => (
            <button
              key={`${chip.key}:${chip.label}`}
              type="button"
              onClick={() => clearSingleFilter(chip.key)}
              className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-1 text-xs"
            >
              <span>{chip.label}</span>
              <span className="text-slate-400">×</span>
            </button>
          ))}

          <button
            type="button"
            onClick={onClearAllFilters}
            disabled={loading}
            className="rounded-full border border-rose-500/50 px-2.5 py-1 text-xs text-rose-200 disabled:opacity-40"
          >
            Limpar todos
          </button>
        </div>
      ) : null}
    </>
  );
}
